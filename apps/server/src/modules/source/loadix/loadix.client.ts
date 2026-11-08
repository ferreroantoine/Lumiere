import type { LoadixRelease, LoadixReleases, TitleKind } from '@lumiere/shared';
import { UpstreamError, errorMessage } from '../../../core/errors';
import { normalizeText } from '../../../core/text';
import { USER_AGENT } from '../transport';

/**
 * Client de l'API publique de loadix.fun (celle qu'utilise son site), en lecture seule :
 *
 *   GET api/media/search?q=&type=movie|series&pageSize=   fiches, avec leur identifiant TMDB
 *   GET api/media/{id}/links?provider=1fichier&perPage=   versions d'une fiche (sans leur lien)
 *
 * Le lien d'une version n'est délivré qu'à un compte connecté, après une vérification
 * anti-robot (« Révéler ») : l'utilisateur le fait sur le site, et Lumière reçoit le lien
 * par le collage ou le favori « Envoyer à Lumière ».
 */

const TIMEOUT_MS = 20_000;
const SEARCH_SIZE = 20;
const LINKS_PER_PAGE = 100;
const MAX_LINK_PAGES = 5;

export interface LoadixClientOptions {
  apiBaseUrl: string;
  siteUrl: string;
}

/** Titre de Lumière cherché sur loadix. */
export interface LoadixTitle {
  kind: TitleKind;
  tmdbId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
}

export interface LoadixMedia {
  id: string;
  title: string;
  year: number | null;
  tmdbId: number | null;
}

/** Version telle que renvoyée par `api/media/{id}/links` (champs utiles). */
export interface LoadixLink {
  id: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeRangeStart: number | null;
  episodeRangeEnd: number | null;
  quality: string | null;
  language: string | null;
  sizeBytes: number | null;
  releaseGroup: string | null;
  releaseName: string | null;
  fileCount: number;
  addedAt: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? Math.trunc(number) : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
}

export function parseMedia(json: Record<string, unknown>): LoadixMedia | null {
  const id = text(json.id);
  if (!id) return null;
  return {
    id,
    title: text(json.title) ?? text(json.originalTitle) ?? '',
    year: integer(json.year),
    tmdbId: integer(json.tmdbId),
  };
}

export function parseLink(json: Record<string, unknown>): LoadixLink | null {
  const id = text(json.id);
  if (!id) return null;
  return {
    id,
    seasonNumber: integer(json.seasonNumber),
    episodeNumber: integer(json.episodeNumber),
    episodeRangeStart: integer(json.episodeRangeStart),
    episodeRangeEnd: integer(json.episodeRangeEnd),
    quality: text(json.quality),
    language: text(json.language),
    sizeBytes: integer(json.sizeBytes),
    releaseGroup: text(json.releaseGroup),
    releaseName: text(json.releaseName),
    fileCount: integer(json.fileCount) ?? 1,
    addedAt: text(json.addedAt),
  };
}

/**
 * Fiche loadix d'un titre : même identifiant TMDB, sinon même titre et même année (à un an
 * près, les dates de sortie varient selon les pays).
 */
export function pickMedia(hits: LoadixMedia[], wanted: LoadixTitle): LoadixMedia | null {
  if (wanted.tmdbId !== null) {
    const exact = hits.find((hit) => hit.tmdbId === wanted.tmdbId);
    if (exact) return exact;
  }
  const names = new Set(
    [wanted.title, wanted.originalTitle].filter(Boolean).map((name) => normalizeText(name ?? '')),
  );
  return (
    hits.find(
      (hit) =>
        (wanted.tmdbId === null || hit.tmdbId === null) &&
        names.has(normalizeText(hit.title)) &&
        (wanted.year === null || hit.year === null || Math.abs(hit.year - wanted.year) <= 1),
    ) ?? null
  );
}

/** Version présentée par Lumière, placée sur sa ligne dans la page loadix du titre. */
export function toRelease(link: LoadixLink, pageUrl: string): LoadixRelease {
  const start = link.episodeRangeStart ?? link.episodeNumber;
  const end = link.episodeRangeEnd;
  const episodes =
    start === null ? null : end !== null && end !== start ? `${start}-${end}` : `${start}`;
  return {
    id: link.id,
    scope: episodes !== null ? 'episode' : link.seasonNumber !== null ? 'season' : 'title',
    season: link.seasonNumber,
    episodes,
    quality: link.quality,
    language: link.language,
    size: link.sizeBytes,
    group: link.releaseGroup,
    name: link.releaseName,
    fileCount: link.fileCount,
    addedAt: link.addedAt,
    url: `${pageUrl}#link-${link.id}`,
  };
}

const SCOPE_ORDER: Record<LoadixRelease['scope'], number> = { season: 0, title: 1, episode: 2 };

/**
 * Versions d'une saison (série) : la saison complète, ses épisodes et les intégrales ; saisons
 * complètes d'abord, puis épisodes dans l'ordre. Pour un film, toutes les versions.
 */
export function releasesFor(releases: LoadixRelease[], season: number | null): LoadixRelease[] {
  if (season === null) return releases;
  return releases
    .filter((release) => release.scope === 'title' || release.season === season)
    .map((release, index) => ({ release, index }))
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.release.scope] - SCOPE_ORDER[b.release.scope] ||
        (Number.parseInt(a.release.episodes ?? '0', 10) || 0) -
          (Number.parseInt(b.release.episodes ?? '0', 10) || 0) ||
        a.index - b.index,
    )
    .map(({ release }) => release);
}

export class LoadixClient {
  constructor(private readonly options: LoadixClientOptions) {}

  /** Versions 1fichier d'un titre (d'une saison pour une série). */
  async releases(title: LoadixTitle, season: number | null): Promise<LoadixReleases> {
    const media = await this.findMedia(title);
    if (!media) return { pageUrl: null, releases: [] };
    const pageUrl = `${this.options.siteUrl}/media/${media.id}`;
    const links = await this.links(media.id);
    return {
      pageUrl,
      releases: releasesFor(
        links.map((link) => toRelease(link, pageUrl)),
        title.kind === 'series' ? season : null,
      ),
    };
  }

  private async findMedia(title: LoadixTitle): Promise<LoadixMedia | null> {
    const queries = [...new Set([title.title, title.originalTitle].filter(Boolean))] as string[];
    for (const query of queries) {
      const json = await this.get('api/media/search', {
        q: query,
        type: title.kind,
        pageSize: String(SEARCH_SIZE),
      });
      const hits = records(json.hits)
        .map(parseMedia)
        .filter((hit) => hit !== null);
      const media = pickMedia(hits, title);
      if (media) return media;
    }
    return null;
  }

  private async links(mediaId: string): Promise<LoadixLink[]> {
    const links: LoadixLink[] = [];
    for (let page = 1; page <= MAX_LINK_PAGES; page++) {
      const json = await this.get(`api/media/${encodeURIComponent(mediaId)}/links`, {
        provider: '1fichier',
        perPage: String(LINKS_PER_PAGE),
        page: String(page),
      });
      const items = records(json.items);
      links.push(...items.map(parseLink).filter((link) => link !== null));
      const total = integer(json.total) ?? 0;
      if (items.length < LINKS_PER_PAGE || links.length >= total) break;
    }
    return links;
  }

  private async get(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `${this.options.apiBaseUrl}/${path}?${new URLSearchParams(query).toString()}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          origin: this.options.siteUrl,
          referer: `${this.options.siteUrl}/`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const detail = errorMessage(error);
      // Le DNS de certaines box renvoie 127.0.0.1 pour les sites bloqués.
      const hint = /ECONNREFUSED (127\.0\.0\.1|::1)|ENOTFOUND/.test(detail)
        ? ' Le DNS de votre box bloque peut-être le site : utilisez un DNS chiffré (voir README).'
        : '';
      throw new UpstreamError(`loadix.fun injoignable : ${detail}.${hint}`);
    }
    if (!response.ok) {
      throw new UpstreamError(`loadix.fun a répondu HTTP ${response.status}.`, response.status);
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new UpstreamError('loadix.fun a renvoyé une réponse illisible.');
    }
  }
}
