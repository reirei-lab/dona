import {openLocalApprovalService} from "./approval/local-service.js";
import { assertTaskGenerationFile } from "./task-execution.js";
import type { DispatcherConfig } from "./config.js";
import { DispatcherApi } from "./api.js";
import { DispatcherDatabase } from "./database.js";
import { AppServerAgentClient,AppServerJobRuntime,runtimeSocket } from "./app-server/adapters.js";

import { JobSupervisor } from "./job-supervisor.js";
import { SlackAdapterJobNotificationVerifier } from "./job-notification-verifier.js";
import { createLogger } from "./logger.js";
import { SystemClock } from "./scheduler/clock.js";
import { SchedulerService } from "./scheduler/service.js";
import { ReminderPublisher, SlackAdapterReminderClient } from "./scheduler/reminder-publisher.js";
import { DispatcherWorker } from "./worker.js";
import { UpdaterClient } from "./updater-client.js";
import {
  SlackAdapterNotificationClient,
  UpdateNotificationDatabase,
  UpdateNotificationWorker,
} from "./update-notification.js";
import { JobProgressCoordinator, JobProgressStore } from "./job-progress.js";
import { startWebJobProjectionMaintenance } from "./web/job-read-maintenance.js";

export async function runService(config: DispatcherConfig): Promise<void> {
  const apiLogger = createLogger("dispatcher_api");
  const workerLogger = createLogger("dispatcher_worker");
  assertTaskGenerationFile(config.databasePath);
  const database = new DispatcherDatabase(config.databasePath, {
    jobsPerEventMax: config.jobsPerEventMax,
    jobObjectiveTotalMaxBytes: config.jobObjectiveTotalMaxBytes,
  });
  database.tasks.assertFreshExecutionModel();
  const updateNotificationDatabase = new UpdateNotificationDatabase(config.updateNotificationDatabasePath);
  let jobProgressStore: JobProgressStore | undefined;
  try {
    jobProgressStore = new JobProgressStore(config.jobProgressDatabasePath);
  } catch (error) {
    apiLogger.warn("Job progress disabled after initialization failure", {
      error_code: "job_progress_initialization_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
  const herdr = new AppServerAgentClient(runtimeSocket(config),config.agentName,config.agentWaitTimeoutMs);
  let jobSupervisor!: JobSupervisor;
  let jobProgress = jobProgressStore
    ? new JobProgressCoordinator(database, jobProgressStore, config, createLogger("dispatcher_job_progress"))
    : undefined;
  const worker = new DispatcherWorker(database, herdr, config, workerLogger,new SlackAdapterJobNotificationVerifier(config), () => jobSupervisor.wake());
  const scheduler = new SchedulerService(
    database.scheduler,
    new SystemClock(),
    () => worker.wake(),
    createLogger("dispatcher_scheduler"),
    { pollMilliseconds: Math.min(config.queuePollMs, 60_000) },
  );
  const reminderPublisher = new ReminderPublisher(database.scheduler, new SlackAdapterReminderClient(config),
    new SystemClock(), createLogger("dispatcher_slack_reminders"), Math.min(config.queuePollMs, 60_000));
  jobSupervisor = new JobSupervisor(
    database,
    new AppServerJobRuntime(config, jobProgress !== undefined,id=>database.getJobLiveSessionIdentity(id)?.herdr_agent_session_id??undefined,id=>!!database.tasks.forAttempt(id),id=>database.hasLocalDashboardJobOwner(id)),
    config,
    createLogger("dispatcher_jobs"),
    () => worker.wake(),
    jobProgress,
  );
  if (!jobProgressStore) await jobSupervisor.disableProgress();
  const updateNotificationWorker = new UpdateNotificationWorker(
    database,
    updateNotificationDatabase,
    new SlackAdapterNotificationClient(config),
    config,
    createLogger("dispatcher_update_notifications"),
  );
  const api = new DispatcherApi(
    database,
    worker,
    jobSupervisor,
    config,
    apiLogger,
    new UpdaterClient(config.updaterSocketPath, config.jobCommandTimeoutMs),
    {
      async quiesce() {
        await external?.stop();
        await scheduler.stop();
        await reminderPublisher.stop();
        worker.quiesceAfterCurrent();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
      },
    },
    updateNotificationWorker,
    jobProgress,
    undefined,
    () => scheduler.wake(),
    scheduler,
  );
  let external:Awaited<ReturnType<typeof openLocalApprovalService>>;
  let stopWebJobProjectionMaintenance:(()=>void)|undefined;

  try {
    try {
      external=await openLocalApprovalService(database,config,()=>{worker.wake();jobSupervisor.wake();},()=>apiLogger.warn("External approval tick unavailable",{error_code:"local_approval_tick_unavailable"}));
    } catch {
      apiLogger.warn("External approval setup requires operator attention",{error_code:"local_approval_setup_required"});
    }
    api.setExternalHealth(()=>external?{configured:true,...external.health()}:{configured:!!config.localApprovalConfigPath,ready:false,reason:"setup_required"});
    api.setExternalApproval(external?.service);
    await api.start();
    // Clear stale/expired outbox fences before due materialization decides overlap for a newer occurrence.
    database.scheduler.recover(new SystemClock().now(), true);
    jobSupervisor.recoverStaleJobs();
    try { await jobProgress?.recover(); }
    catch (error) {
      if((error as Error&{progressRecoveryDeferred?:boolean}).progressRecoveryDeferred&&jobProgress){
        apiLogger.warn("Job progress recovery deferred without releasing delivery fences",{
          error_code:"job_progress_recovery_deferred",
          error_message:error instanceof Error?error.message:String(error),
        });
        void jobProgress.recoverInBackground();
      } else {
      apiLogger.warn("Job progress disabled after recovery failure", {
        error_code: "job_progress_recovery_failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      jobProgressStore?.close();
      jobProgressStore = undefined;
      jobProgress = undefined;
      await jobSupervisor.disableProgress();
      api.disableJobProgress();
      }
    }
    external?.start();
    worker.start();
    scheduler.start();
    reminderPublisher.start();
    jobSupervisor.start();
    updateNotificationWorker.start();
    stopWebJobProjectionMaintenance=startWebJobProjectionMaintenance(database,error=>apiLogger.warn("Web job projection maintenance failed",{
      error_code:"web_job_projection_maintenance_failed",error_message:error instanceof Error?error.message:String(error),
    }));
  } catch (error) {
    stopWebJobProjectionMaintenance?.();
    if (updateNotificationWorker.isRunning()) await updateNotificationWorker.stop();
    if (jobSupervisor.isRunning()) await jobSupervisor.stop();
    if (scheduler.isRunning()) await scheduler.stop();
    if (reminderPublisher.isRunning()) await reminderPublisher.stop();
    if (worker.isRunning()) await worker.stop();
    await api.stop();
    await external?.close();
    database.close();
    updateNotificationDatabase.close();
    jobProgressStore?.close();
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = async (signal: NodeJS.Signals): Promise<void> => {
      if (stopping) return;
      stopping = true;
      apiLogger.info("Graceful shutdown started", { signal });
      try {
        stopWebJobProjectionMaintenance?.();
        await external?.stop();
        api.beginShutdown();
        await api.stop();
        await scheduler.stop();
        await reminderPublisher.stop();
        await updateNotificationWorker.stop();
        await jobSupervisor.stop();
        await worker.stop();
        await external?.close();
        database.close();
        updateNotificationDatabase.close();
        jobProgressStore?.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
}
