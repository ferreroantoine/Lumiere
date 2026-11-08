import { ChevronDown, Download, ExternalLink, Globe, Loader2, Play, Puzzle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CustomSource, LoadixRelease, SeasonEntry, TitleDetails } from '@lumiere/shared';
import { errorMessage } from '../../api/client';
import {
  useEnqueueTitle,
  useLoadixReleases,
  useMovieVersions,
  useSettings,
} from '../../api/queries';
import { ReleaseBadges } from '../../components/media/ReleaseBadges';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { buttonClasses } from '../../components/ui/button-styles';
import { Tabs } from '../../components/ui/Tabs';
import { cn } from '../../lib/cn';
import { formatBytes, formatRelativeDate, plural } from '../../lib/format';
import { playerUrl } from '../../lib/routes';
import { customSourceUrl, isLoadixSource } from '../onefichier/links';
import { openSourceSearch } from '../onefichier/open-dialog';
import { rememberPendingTitle } from '../onefichier/pending-title';
import { DownloadState, PlayButton } from './FileActions';
import { EpisodeVersions } from './EpisodeVersions';

const STREMIO = 'stremio';
const STORAGE_KEY = 'lumiere.source';

function readSourceChoice(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSourceChoice(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Choix non retenu : sans importance.
  }
}

/**
 * « Télécharger » : choix de la source (extensions Stremio, sites personnalisés), puis ce
 * qu'elle propose. Rien n'est demandé aux sources avant ce choix. Pour une série, tout se fait
 * saison par saison (`season`).
 */
export function DownloadCard({ title, season }: { title: TitleDetails; season?: SeasonEntry }) {
  const settings = useSettings().data?.settings;
  const sites = settings?.customSources ?? [];
  const stremio = (settings?.stremioAddonUrls.length ?? 0) > 0;
  const choices = [
    ...(stremio ? [{ value: STREMIO, label: 'Extensions Stremio' }] : []),
    ...sites.map((site) => ({ value: site.id, label: site.name })),
  ];
  const [choice, setChoice] = useState(readSourceChoice);
  const selected = choices.find((item) => item.value === choice)?.value ?? choices[0]?.value;
  const site = sites.find((item) => item.id === selected);
  const heading =
    title.kind === 'movie'
      ? 'Télécharger le film'
      : `Télécharger la saison ${season?.number ?? ''}`;

  return (
    <section
      id="telecharger"
      className="fill flex scroll-mt-28 flex-col gap-4 rounded-card p-4 sm:p-5"
      aria-label={heading}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Download className="size-5 text-brand-300" />
          {heading}
        </h3>
        {choices.length > 1 && selected && (
          <Tabs
            kind="radio"
            label="Source"
            items={choices}
            value={selected}
            onChange={(value) => {
              setChoice(value);
              saveSourceChoice(value);
            }}
          />
        )}
      </div>

      {!settings ? null : choices.length === 0 ? (
        <p className="text-sm text-zinc-400">
          Aucune source configurée. Ajoutez une extension Stremio ou un site (loadix.fun…) dans{' '}
          <Link
            to="/parametres?onglet=sources"
            className="font-medium text-brand-300 underline-offset-2 hover:underline"
          >
            Paramètres → Sources
          </Link>
          .
        </p>
      ) : site && isLoadixSource(site) ? (
        <LoadixPanel title={title} season={season} site={site} />
      ) : site ? (
        <SitePanel title={title} season={season} site={site} />
      ) : title.kind === 'movie' ? (
        <StremioMoviePanel title={title} />
      ) : season ? (
        <StremioSeasonPanel title={title} season={season} />
      ) : null}
    </section>
  );
}

/** Site personnalisé : ouvert sur la recherche du titre, puis le lien est collé dans Lumière. */
function SitePanel({
  title,
  season,
  site,
}: {
  title: TitleDetails;
  season?: SeasonEntry;
  site: CustomSource;
}) {
  const url = customSourceUrl(site, title);
  const seasonNumber = title.kind === 'series' ? (season?.number ?? null) : null;
  // Le site cherche le titre ; la saison se choisit ensuite sur sa page.
  const target =
    title.kind === 'movie' && title.year ? `${title.title} (${title.year})` : title.title;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex max-w-2xl items-start gap-2 text-sm text-zinc-300">
        <Globe className="mt-0.5 size-4 shrink-0 text-zinc-400" />
        <span>
          {site.name} s’ouvre dans un nouvel onglet, sur la recherche de « {title.title} ».
          {seasonNumber !== null
            ? ` Choisissez la saison ${seasonNumber}, de préférence complète (archive .zip),`
            : ' Choisissez une version,'}{' '}
          copiez le lien 1fichier et collez-le dans Lumière : la fenêtre qui s’ouvre vous guide.
        </span>
      </p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={cn(buttonClasses({ variant: 'primary' }), 'shrink-0')}
        onClick={() => {
          rememberPendingTitle({
            id: title.id,
            title: title.title,
            year: title.year,
            kind: title.kind,
            season: seasonNumber,
            source: site.name,
          });
          openSourceSearch({ source: site.name, url, target, season: seasonNumber, release: null });
        }}
      >
        <ExternalLink className="size-4" />
        {seasonNumber !== null
          ? `Chercher la saison ${seasonNumber} sur ${site.name}`
          : `Chercher sur ${site.name}`}
      </a>
    </div>
  );
}

function scopeLabel(release: LoadixRelease): string | null {
  if (release.scope === 'season') return 'Saison complète';
  if (release.episodes === null) return null;
  return release.episodes.includes('-')
    ? `Épisodes ${release.episodes}`
    : `Épisode ${release.episodes}`;
}

/** « Saison complète · WEB 1080p · MULTi VFF · 22,4 Go » : la version à repérer sur le site. */
function describeRelease(release: LoadixRelease): string {
  return [
    scopeLabel(release),
    release.quality,
    release.language,
    release.size ? formatBytes(release.size) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * loadix.fun : ses versions 1fichier sont listées ici (API publique du site). Le lien se
 * révèle sur le site, avec le compte de l'utilisateur, puis revient par collage ou par le favori.
 */
function LoadixPanel({
  title,
  season,
  site,
}: {
  title: TitleDetails;
  season?: SeasonEntry;
  site: CustomSource;
}) {
  const seasonNumber = title.kind === 'series' ? (season?.number ?? null) : null;
  const releases = useLoadixReleases(title.id, seasonNumber);
  const target =
    title.kind === 'movie' && title.year ? `${title.title} (${title.year})` : title.title;

  if (releases.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-400">
        <Loader2 className="size-4 animate-spin" />
        Recherche des versions sur {site.name}…
      </p>
    );
  }
  if (releases.isError || !releases.data.pageUrl) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-zinc-400">
          {releases.isError
            ? errorMessage(releases.error)
            : `« ${title.title} » n’a pas été trouvé sur ${site.name}.`}
        </p>
        <SitePanel title={title} season={season} site={site} />
      </div>
    );
  }
  const { pageUrl, releases: items } = releases.data;
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-zinc-400">
          Aucune version 1fichier
          {seasonNumber !== null ? ` pour la saison ${seasonNumber}` : ''} sur {site.name}.
        </p>
      ) : (
        <p className="flex max-w-2xl items-start gap-2 text-sm text-zinc-300">
          <Globe className="mt-0.5 size-4 shrink-0 text-zinc-400" />
          <span>
            Choisissez une version
            {seasonNumber !== null ? ', de préférence la saison complète,' : ''} : {site.name}{' '}
            s’ouvre sur elle, vous la révélez avec votre compte, puis le lien revient dans Lumière.
          </span>
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((release) => (
          <li
            key={release.id}
            className="flex flex-col gap-2 rounded-[0.9rem] bg-white/[0.05] p-3 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {scopeLabel(release) && <Badge tone="violet">{scopeLabel(release)}</Badge>}
                {release.quality && <Badge tone="brand">{release.quality}</Badge>}
                {release.language && <Badge tone="info">{release.language}</Badge>}
              </div>
              {(release.name ?? release.group) && (
                <p
                  className="mt-1.5 truncate font-mono text-xs text-zinc-300"
                  title={release.name ?? release.group ?? ''}
                >
                  {release.name ?? release.group}
                </p>
              )}
              <p className="mt-0.5 text-xs text-zinc-500">
                {[
                  formatBytes(release.size),
                  release.fileCount > 1 ? plural(release.fileCount, 'fichier') : null,
                  release.addedAt ? `ajoutée ${formatRelativeDate(release.addedAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <a
              href={release.url}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonClasses({ variant: 'glass', size: 'sm' }), 'shrink-0')}
              onClick={() => {
                rememberPendingTitle({
                  id: title.id,
                  title: title.title,
                  year: title.year,
                  kind: title.kind,
                  season: seasonNumber,
                  source: site.name,
                });
                openSourceSearch({
                  source: site.name,
                  url: release.url,
                  target,
                  season: seasonNumber,
                  release: describeRelease(release),
                });
              }}
            >
              <ExternalLink className="size-4" />
              Révéler sur {site.name}
            </a>
          </li>
        ))}
      </ul>
      <a
        href={pageUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 self-start text-xs font-medium text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
      >
        Toutes les versions sur {site.name}
        <ExternalLink className="size-3" />
      </a>
    </div>
  );
}

/** Film : versions proposées par les extensions, demandées à l'ouverture de la liste. */
function StremioMoviePanel({ title }: { title: TitleDetails }) {
  const [open, setOpen] = useState(false);
  const versions = useMovieVersions(title.id, open);
  const enqueue = useEnqueueTitle();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<Download className="size-4" />}
          loading={enqueue.isPending}
          onClick={() => enqueue.mutate({ titleId: title.id })}
          title="La version qui correspond le mieux à vos préférences (qualité, langue)"
        >
          Meilleure version
        </Button>
        <Button
          variant="glass"
          icon={<ChevronDown className={cn('size-4 transition', open && 'rotate-180')} />}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? 'Masquer les versions' : 'Choisir une version'}
        </Button>
      </div>
      {!open && (
        <p className="flex items-start gap-2 text-xs text-zinc-400">
          <Puzzle className="mt-0.5 size-3.5 shrink-0" />
          Les extensions ne sont interrogées qu’à ce moment (leur réserve de liens peut être
          limitée).
        </p>
      )}
      {open && versions.isPending && (
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="size-4 animate-spin" />
          Demande des versions aux extensions…
        </p>
      )}
      {open && versions.isError && (
        <p className="text-sm text-red-300">{errorMessage(versions.error)}</p>
      )}
      {open && versions.data && (
        <div className="flex flex-col gap-2">
          {versions.data.notice && <p className="text-sm text-amber-200">{versions.data.notice}</p>}
          {versions.data.files.length === 0 && !versions.data.notice && (
            <p className="text-sm text-zinc-400">Aucune extension ne propose ce film.</p>
          )}
          {versions.data.files.map((file) => (
            <div
              key={file.path}
              className="flex flex-col gap-2 rounded-[0.9rem] bg-white/[0.05] p-3 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <ReleaseBadges release={file.release} compact />
                <p className="mt-1.5 truncate font-mono text-xs text-zinc-300" title={file.name}>
                  {file.name}
                </p>
                <p className="mt-0.5 truncate text-xs text-zinc-500" title={file.label ?? ''}>
                  {[formatBytes(file.size), file.label].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <DownloadState file={file} titleId={title.id} />
                <PlayButton file={file} label="Regarder" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Saison : toute la saison d'un coup, ou épisode par épisode (versions à la demande). */
function StremioSeasonPanel({ title, season }: { title: TitleDetails; season: SeasonEntry }) {
  const enqueue = useEnqueueTitle();
  const navigate = useNavigate();
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const missing = season.episodes.filter(
    (episode) => !episode.files.some((file) => file.availability.libraryItemId !== null),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<Download className="size-4" />}
          loading={enqueue.isPending}
          disabled={missing.length === 0}
          onClick={() => enqueue.mutate({ titleId: title.id, season: season.number })}
          title="Chaque épisode est demandé aux extensions, un par un (version préférée)"
        >
          {missing.length === 0
            ? 'Saison complète sur le disque'
            : missing.length === season.episodes.length
              ? 'Toute la saison'
              : `Les ${missing.length} épisodes manquants`}
        </Button>
        <Button
          variant="glass"
          icon={<ChevronDown className={cn('size-4 transition', episodesOpen && 'rotate-180')} />}
          onClick={() => setEpisodesOpen((value) => !value)}
          aria-expanded={episodesOpen}
        >
          Épisode par épisode
        </Button>
      </div>
      {episodesOpen && (
        <ul className="flex flex-col gap-1.5">
          {season.episodes.map((episode) => {
            if (episode.season === null || episode.episode === null) return null;
            const { season: seasonNumber, episode: number } = episode;
            const open = expanded === episode.key;
            return (
              <li key={episode.key} className="rounded-[0.9rem] bg-white/[0.05] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-sm font-semibold text-zinc-400 tabular-nums">
                    {number}.
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                    {episode.title}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ChevronDown className={cn('size-4 transition', open && 'rotate-180')} />}
                    onClick={() => setExpanded(open ? null : episode.key)}
                    aria-expanded={open}
                  >
                    <span className="hidden sm:inline">Versions</span>
                  </Button>
                  <Button
                    size="icon-sm"
                    icon={<Download className="size-4" />}
                    onClick={() =>
                      enqueue.mutate({ titleId: title.id, season: seasonNumber, episode: number })
                    }
                    aria-label={`Télécharger l’épisode ${number}`}
                    title="Télécharger la version préférée"
                  />
                  <Button
                    size="icon-sm"
                    variant="primary"
                    icon={<Play className="size-4 fill-current" />}
                    onClick={() =>
                      navigate(
                        playerUrl({
                          type: 'episode',
                          titleId: title.id,
                          season: seasonNumber,
                          episode: number,
                        }),
                      )
                    }
                    aria-label={`Regarder l’épisode ${number} en streaming`}
                    title="Regarder en streaming (version préférée)"
                  />
                </div>
                {open && (
                  <EpisodeVersions titleId={title.id} season={seasonNumber} episode={number} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
