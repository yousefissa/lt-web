import { parentPort, workerData } from 'node:worker_threads';
import { runGlobalWorkerPayload, type GlobalWorkerPayload } from './global-policy';

const result = await runGlobalWorkerPayload(workerData as GlobalWorkerPayload);
parentPort?.postMessage(result);
