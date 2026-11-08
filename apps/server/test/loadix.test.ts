import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LoadixClient,
  parseLink,
  pickMedia,
  releasesFor,
  toRelease,
  type LoadixMedia,
  type LoadixTitle,
} from '../src/modules/source/loadix/loadix.client';
import { json, listen } from './helpers/fakes';

const DUNE: LoadixTitle = {
  kind: 'movie',
  tmdbId: 438631,
  title: 'Dune',
  originalTitle: 'Dune',
  year: 2021,
};

describe('fiche loadix d’un titre', () => {
  const hits: LoadixMedia[] = [
    { id: 'dune-1984', title: 'Dune', year: 1984, tmdbId: 841 },
    { id: 'dune-2021', title: 'Dune', year: 2021, tmdbId: 438631 },
  ];

  it('retient la fiche du même identifiant TMDB', () => {
    expect(pickMedia(hits, DUNE)?.id).toBe('dune-2021');
  });

  it('sans identifiant TMDB, compare le titre (accents, casse) et l’année à un an près', () => {
    const wanted = { ...DUNE, tmdbId: null, title: 'DÛNE', year: 2022 };
    expect(pickMedia(hits, wanted)?.id).toBe('dune-2021');
    expect(pickMedia(hits, { ...wanted, year: 1990 })).toBeNull();
  });

  it('n’associe pas deux identifiants TMDB différents sur le seul titre', () => {
    expect(pickMedia(hits, { ...DUNE, tmdbId: 1 })).toBeNull();
  });
});

describe('versions loadix', () => {
  const PAGE = 'https://loadix.fun/media/abc';

  function link(fields: Record<string, unknown>) {
    const parsed = parseLink({ id: 'l', fileCount: 1, ...fields });
    if (!parsed) throw new Error('lien illisible');
    return parsed;
  }

  it('lit une version et la place sur sa ligne dans la page du titre', () => {
    const release = toRelease(
      link({
        id: 'l1',
        quality: 'REMUX UHD',
        language: 'MULTi VF2',
        sizeBytes: '80945357931',
        releaseGroup: 'HYPERION',
        addedAt: '2026-10-11T21:52:00.495Z',
      }),
      PAGE,
    );
    expect(release).toEqual({
      id: 'l1',
      scope: 'title',
      season: null,
      episodes: null,
      quality: 'REMUX UHD',
      language: 'MULTi VF2',
      size: 80945357931,
      group: 'HYPERION',
      name: null,
      fileCount: 1,
      addedAt: '2026-10-11T21:52:00.495Z',
      url: 'https://loadix.fun/media/abc#link-l1',
    });
  });

  it('distingue saison complète, épisode et plage d’épisodes', () => {
    expect(toRelease(link({ seasonNumber: 2 }), PAGE)).toMatchObject({
      scope: 'season',
      season: 2,
      episodes: null,
    });
    expect(toRelease(link({ seasonNumber: 2, episodeNumber: 5 }), PAGE).episodes).toBe('5');
    expect(
      toRelease(link({ seasonNumber: 2, episodeRangeStart: 1, episodeRangeEnd: 6 }), PAGE),
    ).toMatchObject({ scope: 'episode', episodes: '1-6' });
  });

  it('pour une saison : saison complète d’abord, puis ses épisodes, avec les intégrales', () => {
    const releases = [
      toRelease(link({ id: 'e3', seasonNumber: 2, episodeNumber: 3 }), PAGE),
      toRelease(link({ id: 's1', seasonNumber: 1 }), PAGE),
      toRelease(link({ id: 'e1', seasonNumber: 2, episodeNumber: 1 }), PAGE),
      toRelease(link({ id: 'all' }), PAGE),
      toRelease(link({ id: 's2', seasonNumber: 2 }), PAGE),
    ];
    expect(releasesFor(releases, 2).map((release) => release.id)).toEqual([
      's2',
      'all',
      'e1',
      'e3',
    ]);
    expect(releasesFor(releases, null)).toHaveLength(5);
  });
});

describe('client loadix (fausse API)', () => {
  let server: http.Server;
  let client: LoadixClient;
  const requests: string[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (url.pathname === '/api/media/search') {
        // Le titre français n'est pas sur loadix : seul le titre original le trouve.
        const hits =
          url.searchParams.get('q') === 'The Office'
            ? [{ id: 'office', type: 'series', title: 'The Office', year: 2005, tmdbId: 2316 }]
            : [];
        return json(response, 200, { hits });
      }
      if (url.pathname === '/api/media/office/links') {
        const page = Number(url.searchParams.get('page'));
        const items = Array.from({ length: page === 1 ? 100 : 3 }, (_, index) => ({
          id: `p${page}-${index}`,
          seasonNumber: index === 0 ? 2 : 1,
          fileCount: 1,
        }));
        return json(response, 200, { items, page, perPage: 100, total: 103 });
      }
      json(response, 404, { code: 'not_found' });
    });
    const baseUrl = await listen(server);
    client = new LoadixClient({ apiBaseUrl: baseUrl, siteUrl: 'https://loadix.test' });
  });

  afterAll(() => {
    server.close();
  });

  it('trouve la série par son titre original et lit toutes les pages de versions 1fichier', async () => {
    const result = await client.releases(
      {
        kind: 'series',
        tmdbId: 2316,
        title: 'Le Bureau',
        originalTitle: 'The Office',
        year: 2005,
      },
      2,
    );
    expect(result.pageUrl).toBe('https://loadix.test/media/office');
    expect(result.releases.map((release) => release.id)).toEqual(['p1-0', 'p2-0']);
    expect(requests).toEqual([
      '/api/media/search?q=Le+Bureau&type=series&pageSize=20',
      '/api/media/search?q=The+Office&type=series&pageSize=20',
      '/api/media/office/links?provider=1fichier&perPage=100&page=1',
      '/api/media/office/links?provider=1fichier&perPage=100&page=2',
    ]);
  });

  it('titre absent de loadix : aucune page, aucune version', async () => {
    expect(await client.releases({ ...DUNE, originalTitle: null }, null)).toEqual({
      pageUrl: null,
      releases: [],
    });
  });
});
