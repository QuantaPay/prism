import { createLogger } from '@stoplight/prism-core';
import { createInstance, IHttpConfig, ProblemJsonError } from '@stoplight/prism-http';
import { DiagnosticSeverity, HttpMethod, IHttpOperation } from '@stoplight/types';
import * as fastify from 'fastify';
import * as fastifyCors from 'fastify-cors';
import { IncomingMessage, ServerResponse } from 'http';
import { defaults } from 'lodash';
import * as typeIs from 'type-is';
import { getHttpConfigFromRequest } from './getHttpConfigFromRequest';
import { serialize } from './serialize';
import { IPrismHttpServer, IPrismHttpServerOpts } from './types';
import { pipe } from 'fp-ts/lib/pipeable'
import * as TaskEither from 'fp-ts/lib/TaskEither'
import * as Task from 'fp-ts/lib/Task'

export const createServer = (operations: IHttpOperation[], opts: IPrismHttpServerOpts): IPrismHttpServer => {
  const { components, config } = opts;

  const server = fastify({
    logger: (components && components.logger) || createLogger('HTTP SERVER'),
    disableRequestLogging: true,
    modifyCoreObjects: false,
  });

  if (opts.cors) server.register(fastifyCors);

  server.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    if (typeIs(req, ['application/*+json'])) {
      try {
        return done(null, JSON.parse(body));
      } catch (e) {
        return done(e);
      }
    }

    if (typeIs(req, ['application/x-www-form-urlencoded'])) {
      return done(null, body);
    }

    const error: Error & { status?: number } = new Error(`Unsupported media type.`);
    error.status = 415;
    Error.captureStackTrace(error);
    return done(error);
  });

  const mergedConfig = defaults<unknown, IHttpConfig>(config, {
    mock: { dynamic: false },
    validateRequest: true,
    validateResponse: true,
    checkSecurity: true,
  });

  const prism = createInstance(mergedConfig, components);

  const replyHandler: fastify.RequestHandler<IncomingMessage, ServerResponse> = (request, reply) => {
    const {
      req: { method, url },
      body,
      headers,
      query,
    } = request;

    const input = {
      method: (method ? method.toLowerCase() : 'get') as HttpMethod,
      url: {
        path: (url || '/').split('?')[0],
        query,
        baseUrl: query.__server,
      },
      headers,
      body,
    };

    request.log.info({ input }, 'Request received');
    const operationSpecificConfig = getHttpConfigFromRequest(input);
    const mockConfig = opts.config.mock === false ? false : { ...opts.config.mock, ...operationSpecificConfig };

    const prismRequest = prism.request(input, operations, {
      ...opts.config,
      mock: mockConfig,
    });

    return pipe(
      prismRequest,
      TaskEither.fold(error => {
        const problemJsonError = ProblemJsonError.fromPlainError(error);

        if (!reply.sent) {
          reply
            .type('application/problem+json')
            .serializer(JSON.stringify)
            .code(problemJsonError.status);

          if (problemJsonError.headers) {
            reply.headers(problemJsonError.headers);
          }

          reply.send(problemJsonError);
        } else {
          reply.res.end();
        }

        request.log.error({ input, offset: 1 }, `Request terminated with error: ${error}`);

        return Task.of(reply);
      }, response => {
        const { output } = response;

        reply.code(output.statusCode);

        if (output.headers) {
          reply.headers(output.headers);
        }

        response.validations.output.forEach(validation => {
          if (validation.severity === DiagnosticSeverity.Error) {
            request.log.error(`${validation.path} — ${validation.message}`);
          } else if (validation.severity === DiagnosticSeverity.Warning) {
            request.log.warn(`${validation.path} — ${validation.message}`);
          } else {
            request.log.info(`${validation.path} — ${validation.message}`);
          }
        });

        return Task.of(reply.serializer((payload: unknown) => serialize(payload, reply.getHeader('content-type'))).send(output.body));

      })
    )()
  };

  opts.cors
    ? server.route({
      url: '*',
      method: ['GET', 'DELETE', 'HEAD', 'PATCH', 'POST', 'PUT'],
      handler: replyHandler,
    })
    : server.all('*', replyHandler);

  const prismServer: IPrismHttpServer = {
    get prism() {
      return prism;
    },

    get fastify() {
      return server;
    },

    listen: (port: number, ...args: any[]) => server.listen(port, ...args),
  };
  return prismServer;
};
