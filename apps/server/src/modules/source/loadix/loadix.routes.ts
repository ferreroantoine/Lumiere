import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LoadixReleases } from '@lumiere/shared';
import { z } from 'zod';
import type { Container } from '../../../container';
import { NotFoundError } from '../../../core/errors';
import { displayTitle } from '../../catalog/presenters';
import { IdParams } from '../../shared-schemas';

export function registerLoadixRoutes(
  server: FastifyInstance,
  { loadix, metadata }: Container,
): void {
  const app = server.withTypeProvider<ZodTypeProvider>();

  /** Versions 1fichier d'un titre sur loadix.fun (d'une saison pour une série). */
  app.get(
    '/titles/:id/loadix',
    {
      schema: {
        params: IdParams,
        querystring: z.object({ season: z.coerce.number().int().min(0).optional() }),
      },
    },
    async (request): Promise<LoadixReleases> => {
      const row = await metadata.ensureById(request.params.id);
      if (!row) throw new NotFoundError('Titre introuvable.');
      return loadix.releases(
        {
          kind: row.kind,
          tmdbId: row.tmdb_id,
          title: displayTitle(row),
          originalTitle: row.original_title,
          year: row.year ?? (Number(row.release_date?.slice(0, 4)) || null),
        },
        request.query.season ?? null,
      );
    },
  );
}
