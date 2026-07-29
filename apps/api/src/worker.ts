import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';
import { AppModule } from './app.module.js';
import { getEnv } from './config/env.js';
import { PrismaService } from './infra/prisma/prisma.service.js';
import { QueueService } from './infra/queue/queue.service.js';
import { RedisService } from './infra/redis/redis.service.js';
import { QUEUES, QUEUE_NAMES, type QueueName } from './infra/queue/queues.js';
import { ZohoPullService } from './integrations/zoho-pull.service.js';
import { ZohoSyncService } from './integrations/zoho-sync.service.js';

/**
 * Worker entry point.
 *
 * One process hosts all six pools today; each queue keeps its own concurrency,
 * so priority is already structural and a pool can be split into its own
 * deployment later without changing any producer.
 *
 * Handlers are registered per queue as the corresponding feature lands. An
 * unhandled job name fails loudly rather than being silently acknowledged —
 * a silently dropped payment event is the worst outcome available here.
 */
type Handler = (job: Job) => Promise<unknown>;

const handlers: Partial<Record<QueueName, Record<string, Handler>>> = {
  // Populated by feature modules: payment-events, mail, sync, documents,
  // scheduled, insights.
};

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const logger = new Logger('worker');

  // A full application context, so handlers get the same services, adapters and
  // scoped database access the API has.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const redis = app.get(RedisService);

  // FR-ZHO-011/012 (push) and FR-ZHO-030 (pull): a brand with no Zoho
  // connection is a no-op inside each push method, not a failure, so an
  // unconnected brand's jobs succeed and drain quietly.
  const zohoSync = app.get(ZohoSyncService);
  const zohoPull = app.get(ZohoPullService);
  const prisma = app.get(PrismaService);
  const queue = app.get(QueueService);

  handlers.sync = {
    'zoho-push-customer': (job) => zohoSync.pushCustomer(job.data.brandId, job.data.customerId),
    'zoho-push-invoice': (job) => zohoSync.pushInvoice(job.data.brandId, job.data.invoiceId),
    'zoho-push-payment': (job) => zohoSync.pushPayment(job.data.brandId, job.data.paymentId),
    'zoho-pull-brand': (job) => zohoPull.pullBrand(job.data.brandId),
  };

  // The 'scheduled-sync' repeatable job (queues.ts, registered by the API
  // process via QueueService.registerScheduledJobs) fires every 15 minutes.
  // Its only job here is fan-out: find every brand with a live Zoho
  // connection and enqueue one pull job each onto the sync queue, where the
  // existing per-job concurrency and retry/backoff already apply.
  handlers.scheduled = {
    'scheduled-sync': async () => {
      const connectedBrandIds = await prisma.withoutScope(
        'scheduled-sync: listing brands with a live Zoho connection',
        (client) =>
          client.integrationConnection.findMany({
            where: { provider: 'ZOHO_BOOKS', status: 'CONNECTED', encryptedCredentials: { not: null } },
            select: { brandId: true },
          }),
      );
      await Promise.all(
        connectedBrandIds.map(({ brandId }) => queue.enqueue('sync', 'zoho-pull-brand', { brandId })),
      );
      return { brandsEnqueued: connectedBrandIds.length };
    },
  };

  const workers = QUEUE_NAMES.map((name) => {
    const definition = QUEUES[name];
    const worker = new Worker(
      name,
      async (job) => {
        const handler = handlers[name]?.[job.name];
        if (!handler) {
          throw new Error(`no handler registered for ${name}/${job.name}`);
        }
        return handler(job);
      },
      {
        connection: redis.createQueueConnection(`worker-${name}`),
        concurrency: Math.min(definition.concurrency, env.WORKER_CONCURRENCY),
      },
    );

    worker.on('failed', (job, error) => {
      logger.error(`${name}/${job?.name ?? 'unknown'} failed: ${error.message}`);
    });
    worker.on('error', (error) => logger.error(`${name} worker error: ${error.message}`));

    return worker;
  });

  logger.log(`workers running: ${QUEUE_NAMES.join(', ')}`);

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received, draining workers`);
    await Promise.allSettled(workers.map((w) => w.close()));
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
