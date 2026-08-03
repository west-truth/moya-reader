import type { FastifyBaseLogger, FastifyLogFn } from 'fastify';
import { currentCorrelationContext } from './context.js';
import { redactLogFields } from './redaction.js';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogSink {
  write(line: string, level: LogLevel): void;
}

export interface StructuredLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  trace(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  fastify: FastifyBaseLogger;
}

export function createStructuredLogger(options: {
  service: 'api' | 'worker';
  sink?: LogSink;
  now?: () => Date;
}): StructuredLogger {
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? (() => new Date());

  const write = (
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
    bindings: Record<string, unknown> = {},
  ) => {
    const payload = redactLogFields({
      timestamp: now().toISOString(),
      level,
      service: options.service,
      event: safeEventName(event),
      ...bindings,
      ...currentCorrelationContext(),
      ...fields,
    });
    sink.write(JSON.stringify(payload), level);
  };

  const createFastifyLogger = (bindings: Record<string, unknown> = {}): FastifyBaseLogger => {
    const method = (level: LogLevel): FastifyLogFn => {
      return ((...args: unknown[]) => {
        const { event, fields } = fastifyLogArguments(args);
        write(level, event, fields, bindings);
      }) as FastifyLogFn;
    };
    return {
      level: 'info',
      trace: method('trace'),
      debug: method('debug'),
      info: method('info'),
      warn: method('warn'),
      error: method('error'),
      fatal: method('fatal'),
      silent: method('trace'),
      child: (childBindings) => createFastifyLogger({ ...bindings, ...childBindings }),
    };
  };

  return {
    log: (level, event, fields) => write(level, event, fields),
    trace: (event, fields) => write('trace', event, fields),
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    fastify: createFastifyLogger(),
  };
}

function fastifyLogArguments(args: unknown[]): { event: string; fields: Record<string, unknown> } {
  const object = args.find((argument) => argument !== null && typeof argument === 'object');
  const message = args.find((argument) => typeof argument === 'string');
  return {
    event: typeof message === 'string' ? message : 'application_log',
    fields:
      object instanceof Error
        ? { errorName: object.name }
        : object && typeof object === 'object'
          ? (object as Record<string, unknown>)
          : {},
  };
}

function safeEventName(event: string): string {
  return /^[a-z][a-z0-9_.-]{1,63}$/.test(event) ? event : 'application_log';
}

const consoleSink: LogSink = {
  write(line, level) {
    if (level === 'error' || level === 'fatal') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  },
};
