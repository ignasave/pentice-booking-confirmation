import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { LogController } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const errorResponse = z.object({
  statusCode: z.number(),
  code: z.string(),
  error: z.string(),
  message: z.string(),
});

/**
 * The Fastify instance both services start from. Route schemas are zod schemas: they
 * validate the request, type the handler, serialise the response and fill the OpenAPI
 * document, which Swagger UI shows at `/docs`.
 */
export async function createApp(options: { logger: boolean; title: string; description: string }) {
  const app = Fastify({
    logger: options.logger,
    // On close, end keep-alive connections too: one left open by a client would hold up shutdown.
    forceCloseConnections: true,
    // No line per request: a path can be a confirmation code.
    logController: new LogController({ disableRequestLogging: true }),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  // A response is parsed by its schema before it is sent, so a key the schema does not
  // declare never leaves the service.
  app.setSerializerCompiler(serializerCompiler);
  // The switch above also silences Fastify's own error line, so a 5xx is logged here.
  app.addHook('onError', async (request, _reply, error) => {
    if ((error.statusCode ?? 500) >= 500) request.log.error({ err: error }, 'Request failed');
  });
  await app.register(swagger, {
    openapi: {
      info: { title: options.title, description: options.description, version: '1.0.0' },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  return app;
}
