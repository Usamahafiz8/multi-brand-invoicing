import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { RedisService } from '../redis/redis.service.js';
import { QUEUES, QUEUE_NAMES, SCHEDULED_JOBS, type QueueName } from './queues.js';

/**
 * Owns the producer side of every queue. Workers live in the worker process
 * (src/worker.ts) so a slow render or a Zoho outage cannot consume capacity the
 * API needs to answer requests.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    for (const name of QUEUE_NAMES) {
      const definition = QUEUES[name];
      this.queues.set(
        name,
        new Queue(name, {
          connection: this.redis.createQueueConnection(`queue-${name}`),
          defaultJobOptions: definition.defaultJobOptions,
        }),
      );
    }
    this.logger.log(`queues ready: ${QUEUE_NAMES.join(', ')}`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }

  get(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`queue "${name}" was not initialised`);
    return queue;
  }

  /**
   * Enqueues work. `brandId` becomes the BullMQ job group so one brand's
   * backlog cannot starve another's (per-brand isolation, NFR-SCL-010).
   */
  async enqueue(
    queue: QueueName,
    jobName: string,
    payload: Record<string, unknown> & { brandId?: string },
    options: JobsOptions = {},
  ): Promise<string> {
    const job = await this.get(queue).add(jobName, payload, {
      priority: QUEUES[queue].priority,
      ...options,
    });
    return job.id ?? '';
  }

  /**
   * Registers the repeatable jobs from TDD-001 §14.2. Idempotent: BullMQ keys
   * repeatables by name and pattern, so re-running on deploy does not duplicate.
   */
  async registerScheduledJobs(): Promise<void> {
    const scheduled = this.get('scheduled');
    for (const job of SCHEDULED_JOBS) {
      await scheduled.add(
        job.name,
        { scheduledJob: job.name },
        { repeat: { pattern: job.cron }, jobId: `cron:${job.name}` },
      );
    }
    this.logger.log(`registered ${SCHEDULED_JOBS.length} scheduled jobs`);
  }

  /** Queue depths, for the health endpoint and the operations dashboard. */
  async counts(): Promise<Record<QueueName, Record<string, number>>> {
    const entries = await Promise.all(
      QUEUE_NAMES.map(async (name) => [name, await this.get(name).getJobCounts()] as const),
    );
    return Object.fromEntries(entries) as Record<QueueName, Record<string, number>>;
  }
}
