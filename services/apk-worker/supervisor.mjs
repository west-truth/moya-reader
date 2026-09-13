import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const methods = new Set([
  'describe',
  'list',
  'detail',
  'chapters',
  'pages',
  'image',
  'cover',
  'preferences',
  'preferences-save',
]);
const safeErrors = new Set(['apk_request_timeout', 'apk_android_feature_unsupported', 'apk_request_failed']);
/** One serial lane per installation. Cancellation kills the active worker, never replays network operations. */
export class ApkWorkerSupervisor {
  #child;
  #active;
  #queue = [];
  #chunks = [];
  #length = 0;
  #closed = false;
  #idle;
  get busy() {
    return !!this.#active || this.#queue.length > 0;
  }
  constructor(
    command,
    args,
    {
      cwd,
      env = {},
      timeoutMs = 45000,
      pagesTimeoutMs = timeoutMs,
      chaptersTimeoutMs = timeoutMs,
      idleMs = 10 * 60 * 1000,
      queueLimit = 32,
    } = {},
  ) {
    this.launch = () => spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.timeoutMs = timeoutMs;
    this.pagesTimeoutMs = pagesTimeoutMs;
    this.chaptersTimeoutMs = chaptersTimeoutMs;
    this.idleMs = idleMs;
    this.queueLimit = queueLimit;
  }
  request(method, params = {}, signal = new AbortController().signal) {
    if (this.#closed) return Promise.reject(new Error('apk_worker_closed'));
    if (!methods.has(method)) return Promise.reject(new Error('apk_method_invalid'));
    if (signal.aborted) return Promise.reject(new Error('cancelled'));
    if (this.#queue.length >= this.queueLimit) return Promise.reject(new Error('apk_worker_busy'));
    const id = randomUUID();
    const frame = Buffer.from(JSON.stringify({ id, method, params }) + '\n');
    if (frame.length > 1024 * 1024) return Promise.reject(new Error('apk_request_limit'));
    return new Promise((resolve, reject) => {
      const task = { id, frame, method, resolve, reject, signal, abort: undefined, timer: undefined };
      task.abort = () => {
        if (this.#active === task) this.#fail('cancelled');
        else {
          const index = this.#queue.indexOf(task);
          if (index >= 0) this.#queue.splice(index, 1);
          this.#settle(task, new Error('cancelled'));
        }
      };
      signal.addEventListener('abort', task.abort, { once: true });
      this.#queue.push(task);
      this.#pump();
    });
  }
  #settle(task, error, result) {
    clearTimeout(task.timer);
    task.signal.removeEventListener('abort', task.abort);
    if (error) task.reject(error);
    else task.resolve(result);
  }
  #start() {
    const child = this.launch();
    this.#child = child;
    this.#chunks = [];
    this.#length = 0;
    // Do not retain raw extension stderr: it may contain URLs, cookies or page contents.
    child.stderr.on('data', () => {});
    child.on('error', () => {
      if (this.#child === child) this.#fail('apk_worker_unavailable');
    });
    child.on('exit', () => {
      if (this.#child === child) this.#fail('apk_worker_exited');
    });
    child.stdin.on('error', () => {
      if (this.#child === child) this.#fail('apk_worker_exited');
    });
    child.stdout.on('data', (data) => {
      if (this.#child !== child) return;
      if (!this.#active || this.#length + data.length > 29 * 1024 * 1024) return this.#fail('apk_response_invalid');
      this.#chunks.push(data);
      this.#length += data.length;
      const end = data.indexOf(10);
      if (end < 0) return;
      if (end !== data.length - 1) return this.#fail('apk_response_invalid');
      let message;
      try {
        message = JSON.parse(Buffer.concat(this.#chunks, this.#length).toString('utf8'));
      } catch {
        return this.#fail('apk_response_invalid');
      }
      if (
        !message ||
        message.id !== this.#active.id ||
        Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error') ||
        (Object.hasOwn(message, 'error') && !safeErrors.has(message.error))
      )
        return this.#fail('apk_response_invalid');
      const task = this.#active;
      this.#active = undefined;
      this.#chunks = [];
      this.#length = 0;
      this.#settle(task, message.error ? new Error(message.error) : undefined, message.result);
      this.#pump();
    });
  }
  #pump() {
    if (this.#closed || this.#active) return;
    clearTimeout(this.#idle);
    const task = this.#queue.shift();
    if (!task) {
      this.#idle = setTimeout(() => this.#stop(), this.idleMs);
      this.#idle.unref?.();
      return;
    }
    this.#active = task;
    try {
      if (!this.#child) this.#start();
      task.timer = setTimeout(
        () => this.#fail('apk_request_timeout'),
        task.method === 'chapters'
          ? this.chaptersTimeoutMs
          : task.method === 'pages'
            ? this.pagesTimeoutMs
            : this.timeoutMs,
      );
      this.#child.stdin.write(task.frame);
    } catch {
      this.#fail('apk_worker_unavailable');
    }
  }
  #stop() {
    const child = this.#child;
    this.#child = undefined;
    this.#chunks = [];
    this.#length = 0;
    if (child) {
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
  }
  #fail(code) {
    this.#stop();
    const task = this.#active;
    this.#active = undefined;
    if (task) this.#settle(task, new Error(code));
    this.#pump();
  }
  close() {
    this.#closed = true;
    clearTimeout(this.#idle);
    this.#stop();
    if (this.#active) this.#settle(this.#active, new Error('apk_worker_closed'));
    this.#active = undefined;
    for (const task of this.#queue.splice(0)) this.#settle(task, new Error('apk_worker_closed'));
  }
}
