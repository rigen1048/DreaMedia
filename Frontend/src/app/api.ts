import { API_BASE, gql } from "../lib/gql";
import type { ExtDomain, ExtLearnedSite, Workspace } from "../lib/types";

const WORKSPACE_QUERY = `
  query Workspace {
    viewer { id username role }
    ytFeed(limit: 300) {
      id channelId title url thumbnail publishedAt seen channel channelLogo
      mode alertsEnabled label domain subdomain
    }
    ytChannels(includeBlocked: true) {
      id name url logo label labelReason rssId kind active rank words
      withholdThreshold
      domain subdomain domainId subdomainId alerts alertsEnabled
    }
    ytDomains {
      id name active alerts channelCount
      subdomains { id name active alerts channelCount blockedCount }
    }
    ytUnassignedCount
    ytCards {
      id name createdAt total done
      items { id videoId url title thumbnail done addedAt }
    }
    aniEntries(includeBlocked: true) {
      id title cover label labelReason list watchState active alertsRelease
      alertsEnabled canonOnly animeType airingTime domainId subdomainId domain
      subdomain cursorSeason cursorEpisode positionSeconds totalSeasons
      episodeCount airedCount watchedSeasons releaseDate nextAiringAt nextAiringEp
      seasons {
        seasonNo title status episodesTotal episodesAired state watched
        startDate releaseDate nextAiringAt nextAiringEp poster
      }
    }
    aniEvents(includeSeen: true) {
      id entryId title cover animeType seasonNo kind group bucket label tier
      seen createdAt payload domain subdomain alertsEnabled
    }
    aniDomains {
      id name active alerts channelCount
      subdomains { id name active alerts channelCount blockedCount }
    }
  }
`;

export function fetchWorkspace(): Promise<Workspace> {
  return gql<Workspace>(WORKSPACE_QUERY);
}

export function fetchViewer(): Promise<Pick<Workspace, "viewer">> {
  return gql<Pick<Workspace, "viewer">>(`query Viewer { viewer { id username role } }`);
}

/* ------------------------------------------------------------------ auth */
export const login = (username: string, password: string) =>
  gql<{ login: { id: number; username: string } }>(
    `mutation Login($username: String!, $password: String!) {
      login(username: $username, password: $password) { id username role }
    }`,
    { username, password },
  );

export const signup = (username: string, password: string) =>
  gql<{ signup: { id: number; username: string } }>(
    `mutation Signup($username: String!, $password: String!) {
      signup(username: $username, password: $password) { id username role }
    }`,
    { username, password },
  );

export const logout = () => gql<{ logout: boolean }>(`mutation Logout { logout }`);

/* -------------------------------------------------------------- YouTube */
export const subscribeYoutube = (input: {
  kind: string;
  link: string;
  words?: string[];
  rank?: string;
  domain?: string;
  subdomain?: string;
}) =>
  gql<{ ytSubscribe: number }>(
    `mutation Subscribe($kind: String!, $link: String!, $words: [String!], $rank: String, $domain: String, $subdomain: String) {
      ytSubscribe(kind: $kind, link: $link, words: $words, rank: $rank, domain: $domain, subdomain: $subdomain)
    }`,
    input,
  );

export const ytSetMode = (
  channelId: number,
  kind: string,
  words?: string[],
  rank?: string,
  withhold?: number | null,
) =>
  gql<{ ytSwitchMode: boolean }>(
    `mutation SetMode($id: Int!, $kind: String!, $words: [String!], $rank: String, $withhold: Int) {
      ytSwitchMode(channelId: $id, kind: $kind, words: $words, rank: $rank, withhold: $withhold)
    }`,
    { id: channelId, kind, words, rank, withhold: withhold ?? null },
  );

export const ytSetAlerts = (channelId: number, alerts: boolean) =>
  gql<{ ytSetAlerts: boolean }>(
    `mutation SetNotify($id: Int!, $alerts: Boolean!) { ytSetAlerts(channelId: $id, alerts: $alerts) }`,
    { id: channelId, alerts },
  );

export const ytSetActive = (channelId: number, active: boolean) =>
  gql<{ ytSetActive: boolean }>(
    `mutation SetActive($id: Int!, $active: Boolean!) { ytSetActive(channelId: $id, active: $active) }`,
    { id: channelId, active },
  );

export const ytSetLabel = (channelId: number, label: string, reason?: string) =>
  gql<{ ytSetLabel: boolean }>(
    `mutation SetLabel($id: Int!, $label: String!, $reason: String) {
      ytSetLabel(channelId: $id, label: $label, reason: $reason)
    }`,
    { id: channelId, label, reason },
  );

export const ytAssignChannel = (channelId: number, subdomainId: number | null) =>
  gql<{ ytAssignChannel: boolean }>(
    `mutation Assign($id: Int!, $subdomainId: Int) {
      ytAssignChannel(channelId: $id, subdomainId: $subdomainId)
    }`,
    { id: channelId, subdomainId },
  );

export const ytDeleteChannel = (channelId: number) =>
  gql<{ ytDeleteChannel: boolean }>(
    `mutation DeleteChannel($id: Int!) { ytDeleteChannel(channelId: $id) }`,
    { id: channelId },
  );

/* -------------------------------------------------------------- Batch YouTube */
export const ytBatchSetMode = (
  channelIds: number[],
  kind: string,
  words?: string[],
  rank?: string,
  withhold?: number | null,
) =>
  gql<{ ytBatchSetMode: number }>(
    `mutation BatchSetMode($ids: [Int!]!, $kind: String!, $words: [String!], $rank: String, $withhold: Int) {
      ytBatchSetMode(channelIds: $ids, kind: $kind, words: $words, rank: $rank, withhold: $withhold)
    }`,
    { ids: channelIds, kind, words, rank, withhold: withhold ?? null },
  );

export const ytBatchSetAlerts = (channelIds: number[], alerts: boolean) =>
  gql<{ ytBatchSetAlerts: number }>(
    `mutation BatchSetAlerts($ids: [Int!]!, $alerts: Boolean!) {
      ytBatchSetAlerts(channelIds: $ids, alerts: $alerts)
    }`,
    { ids: channelIds, alerts },
  );

export const ytBatchSetActive = (channelIds: number[], active: boolean) =>
  gql<{ ytBatchSetActive: number }>(
    `mutation BatchSetActive($ids: [Int!]!, $active: Boolean!) {
      ytBatchSetActive(channelIds: $ids, active: $active)
    }`,
    { ids: channelIds, active },
  );

export const ytBatchAssignChannel = (channelIds: number[], subdomainId: number | null) =>
  gql<{ ytBatchAssignChannel: number }>(
    `mutation BatchAssignChannel($ids: [Int!]!, $subdomainId: Int) {
      ytBatchAssignChannel(channelIds: $ids, subdomainId: $subdomainId)
    }`,
    { ids: channelIds, subdomainId },
  );

export const ytBatchSetLabel = (channelIds: number[], label: string, reason?: string) =>
  gql<{ ytBatchSetLabel: number }>(
    `mutation BatchSetLabel($ids: [Int!]!, $label: String!, $reason: String) {
      ytBatchSetLabel(channelIds: $ids, label: $label, reason: $reason)
    }`,
    { ids: channelIds, label, reason },
  );

export const ytBatchDeleteChannel = (channelIds: number[]) =>
  gql<{ ytBatchDeleteChannel: number }>(
    `mutation BatchDeleteChannel($ids: [Int!]!) {
      ytBatchDeleteChannel(channelIds: $ids)
    }`,
    { ids: channelIds },
  );

export const ytMarkSeen = (videoIds: number[], seen = true) =>
  gql<{ ytMarkSeen: number }>(
    `mutation MarkSeen($ids: [Int!]!, $seen: Boolean!) { ytMarkSeen(videoIds: $ids, seen: $seen) }`,
    { ids: videoIds, seen },
  );

export const ytCreateDomain = (name: string) =>
  gql<{ ytCreateDomain: number }>(
    `mutation AddDomain($name: String!) { ytCreateDomain(name: $name) }`,
    { name },
  );

export const ytRenameDomain = (domainId: number, name: string) =>
  gql<{ ytRenameDomain: boolean }>(
    `mutation RenameDomain($id: Int!, $name: String!) { ytRenameDomain(domainId: $id, name: $name) }`,
    { id: domainId, name },
  );

export const ytDeleteDomain = (domainId: number) =>
  gql<{ ytDeleteDomain: boolean }>(
    `mutation DelDomain($id: Int!) { ytDeleteDomain(domainId: $id) }`,
    {
      id: domainId,
    },
  );

export const ytSetDomainAlerts = (domainId: number, alerts: boolean) =>
  gql<{ ytSetDomainAlerts: boolean }>(
    `mutation DomainNotify($id: Int!, $alerts: Boolean!) { ytSetDomainAlerts(domainId: $id, alerts: $alerts) }`,
    { id: domainId, alerts },
  );

export const ytCreateSubdomain = (domainId: number, name: string) =>
  gql<{ ytCreateSubdomain: number }>(
    `mutation AddSub($domainId: Int!, $name: String!) { ytCreateSubdomain(domainId: $domainId, name: $name) }`,
    { domainId, name },
  );

export const ytRenameSubdomain = (subdomainId: number, name: string) =>
  gql<{ ytRenameSubdomain: boolean }>(
    `mutation RenameSub($id: Int!, $name: String!) { ytRenameSubdomain(subdomainId: $id, name: $name) }`,
    { id: subdomainId, name },
  );

export const ytDeleteSubdomain = (subdomainId: number) =>
  gql<{ ytDeleteSubdomain: boolean }>(
    `mutation DelSub($id: Int!) { ytDeleteSubdomain(subdomainId: $id) }`,
    { id: subdomainId },
  );

export const ytSetSubdomainAlerts = (subdomainId: number, alerts: boolean) =>
  gql<{ ytSetSubdomainAlerts: boolean }>(
    `mutation SubNotify($id: Int!, $alerts: Boolean!) { ytSetSubdomainAlerts(subdomainId: $id, alerts: $alerts) }`,
    { id: subdomainId, alerts },
  );

export const ytCreateCard = (name: string) =>
  gql<{ ytCreateCard: number }>(`mutation AddCard($name: String!) { ytCreateCard(name: $name) }`, {
    name,
  });

export const ytFetchNow = () =>
  gql<{ ytFetchNow: number }>(`mutation FetchNow { ytFetchNow }`);

export const ytRenameCard = (cardId: number, name: string) =>
  gql<{ ytRenameCard: boolean }>(
    `mutation RenameCard($id: Int!, $name: String!) { ytRenameCard(cardId: $id, name: $name) }`,
    { id: cardId, name },
  );

export const ytDeleteCard = (cardId: number) =>
  gql<{ ytDeleteCard: boolean }>(`mutation DelCard($id: Int!) { ytDeleteCard(cardId: $id) }`, {
    id: cardId,
  });

export const ytAddCardItems = (cardId: number, links: string[]) =>
  gql<{ ytAddCardItems: number }>(
    `mutation AddItems($id: Int!, $links: [String!]!) { ytAddCardItems(cardId: $id, links: $links) }`,
    { id: cardId, links },
  );

export const ytSetCardItemDone = (itemId: number, done: boolean) =>
  gql<{ ytSetCardItemDone: boolean }>(
    `mutation ItemDone($id: Int!, $done: Boolean!) { ytSetCardItemDone(itemId: $id, done: $done) }`,
    { id: itemId, done },
  );

export const ytDeleteCardItem = (itemId: number) =>
  gql<{ ytDeleteCardItem: boolean }>(
    `mutation DelItem($id: Int!) { ytDeleteCardItem(itemId: $id) }`,
    { id: itemId },
  );

/* ----------------------------------------------------------------- Anime */
export const aniTrack = (
  title: string,
  listKind = "watching",
  domain?: string,
  subdomain?: string,
) =>
  gql<{ aniTrack: number }>(
    `mutation Track($title: String!, $list: String!, $domain: String, $subdomain: String) {
      aniTrack(title: $title, listKind: $list, domain: $domain, subdomain: $subdomain)
    }`,
    { title, list: listKind, domain, subdomain },
  );

export type EntryPatch = {
  listKind?: string;
  watchState?: string | null;
  label?: string;
  labelReason?: string;
  alertsRelease?: boolean;
  active?: boolean;
  canonOnly?: boolean;
  animeType?: string;
  subdomainId?: number | null;
  clearCategory?: boolean;
};

export const aniUpdateEntry = (entryId: number, patch: EntryPatch) =>
  gql<{ aniUpdateEntry: boolean }>(
    `mutation UpdateEntry(
      $id: Int!, $list: String, $watchState: String, $label: String, $labelReason: String,
      $alerts: Boolean, $active: Boolean, $canon: Boolean, $type: String,
      $subdomainId: Int, $clear: Boolean!
    ) {
      aniUpdateEntry(
        entryId: $id, listKind: $list, watchState: $watchState, label: $label,
        labelReason: $labelReason, alertsRelease: $alerts, active: $active,
        canonOnly: $canon, animeType: $type, subdomainId: $subdomainId, clearCategory: $clear
      )
    }`,
    {
      id: entryId,
      list: patch.listKind,
      watchState: patch.watchState,
      label: patch.label,
      labelReason: patch.labelReason,
      alerts: patch.alertsRelease,
      active: patch.active,
      canon: patch.canonOnly,
      type: patch.animeType,
      subdomainId: patch.subdomainId,
      clear: patch.clearCategory ?? false,
    },
  );

export const aniSetWatched = (entryId: number, seasonNo: number, watched: boolean) =>
  gql<{ aniSetWatched: boolean }>(
    `mutation Watched($id: Int!, $season: Int!, $watched: Boolean!) {
      aniSetWatched(entryId: $id, seasonNo: $season, watched: $watched)
    }`,
    { id: entryId, season: seasonNo, watched },
  );

export const aniSetCursor = (
  entryId: number,
  season: number,
  episode: number | null,
  seconds: number | null,
) =>
  gql<{ aniSetCursor: boolean }>(
    `mutation Cursor($id: Int!, $season: Int!, $episode: Int, $seconds: Int) {
      aniSetCursor(entryId: $id, season: $season, episode: $episode, positionSeconds: $seconds)
    }`,
    { id: entryId, season, episode, seconds },
  );

export const aniMarkRange = (entryId: number, from: number, to: number) =>
  gql<{ aniMarkRange: boolean }>(
    `mutation Range($id: Int!, $from: Int!, $to: Int!) {
      aniMarkRange(entryId: $id, fromSeason: $from, toSeason: $to)
    }`,
    { id: entryId, from, to },
  );

/** Correct the watch position — the only cursor move allowed to go backwards. */
export const aniSetProgress = (
  entryId: number,
  season: number,
  episode: number,
  positionSeconds?: number | null,
) =>
  gql<{ aniSetProgress: boolean }>(
    `mutation Progress($id: Int!, $season: Int!, $episode: Int!, $seconds: Int) {
      aniSetProgress(entryId: $id, season: $season, episode: $episode, positionSeconds: $seconds)
    }`,
    { id: entryId, season, episode, seconds: positionSeconds ?? null },
  );

export const aniFinish = (entryId: number) =>
  gql<{ aniFinish: boolean }>(`mutation Finish($id: Int!) { aniFinish(entryId: $id) }`, {
    id: entryId,
  });

export type AdvanceDecision = {
  action: "watching" | "awaiting" | "completed";
  season: number;
  episode: number | null;
  title: string | null;
  releaseDate: string | null;
  episodesTotal: number | null;
};

export const aniAdvanceSeason = (entryId: number, fromSeason?: number | null) =>
  gql<{ aniAdvanceSeason: AdvanceDecision }>(
    `mutation Advance($id: Int!, $from: Int) {
      aniAdvanceSeason(entryId: $id, fromSeason: $from) {
        action season episode title releaseDate episodesTotal
      }
    }`,
    { id: entryId, from: fromSeason ?? null },
  );

export const aniEventsSeen = (eventIds: number[], seen = true) =>
  gql<{ aniEventsSeen: number }>(
    `mutation EventsSeen($ids: [Int!]!, $seen: Boolean!) { aniEventsSeen(eventIds: $ids, seen: $seen) }`,
    { ids: eventIds, seen },
  );

export const aniDeleteEntry = (entryId: number) =>
  gql<{ aniDeleteEntry: boolean }>(
    `mutation DelEntry($id: Int!) { aniDeleteEntry(entryId: $id) }`,
    {
      id: entryId,
    },
  );

export const aniAssignEntry = (entryId: number, subdomainId: number | null) =>
  gql<{ aniAssignEntry: boolean }>(
    `mutation AssignEntry($id: Int!, $subdomainId: Int) {
      aniAssignEntry(entryId: $id, subdomainId: $subdomainId)
    }`,
    { id: entryId, subdomainId },
  );

export const aniCreateDomain = (name: string) =>
  gql<{ aniCreateDomain: number }>(
    `mutation AddAniDomain($name: String!) { aniCreateDomain(name: $name) }`,
    {
      name,
    },
  );

export const aniRenameDomain = (domainId: number, name: string) =>
  gql<{ aniRenameDomain: boolean }>(
    `mutation RenameAniDomain($id: Int!, $name: String!) { aniRenameDomain(domainId: $id, name: $name) }`,
    { id: domainId, name },
  );

export const aniDeleteDomain = (domainId: number) =>
  gql<{ aniDeleteDomain: boolean }>(
    `mutation DelAniDomain($id: Int!) { aniDeleteDomain(domainId: $id) }`,
    { id: domainId },
  );

export const aniSetDomainAlerts = (domainId: number, alerts: boolean) =>
  gql<{ aniSetDomainAlerts: boolean }>(
    `mutation AniDomainNotify($id: Int!, $alerts: Boolean!) {
      aniSetDomainAlerts(domainId: $id, alerts: $alerts)
    }`,
    { id: domainId, alerts },
  );

export const aniCreateSubdomain = (domainId: number, name: string) =>
  gql<{ aniCreateSubdomain: number }>(
    `mutation AddAniSub($domainId: Int!, $name: String!) {
      aniCreateSubdomain(domainId: $domainId, name: $name)
    }`,
    { domainId, name },
  );

export const aniRenameSubdomain = (subdomainId: number, name: string) =>
  gql<{ aniRenameSubdomain: boolean }>(
    `mutation RenameAniSub($id: Int!, $name: String!) {
      aniRenameSubdomain(subdomainId: $id, name: $name)
    }`,
    { id: subdomainId, name },
  );

export const aniDeleteSubdomain = (subdomainId: number) =>
  gql<{ aniDeleteSubdomain: boolean }>(
    `mutation DelAniSub($id: Int!) { aniDeleteSubdomain(subdomainId: $id) }`,
    { id: subdomainId },
  );

export const aniSetSubdomainAlerts = (subdomainId: number, alerts: boolean) =>
  gql<{ aniSetSubdomainAlerts: boolean }>(
    `mutation AniSubNotify($id: Int!, $alerts: Boolean!) {
      aniSetSubdomainAlerts(subdomainId: $id, alerts: $alerts)
    }`,
    { id: subdomainId, alerts },
  );

/* ----------------------------------------------------------------- admin */
export type AdminBackup = { file: string; size: number; mtime: number };
export type AdminSetting = { key: string; value: string; floor: string | null; kind: string };
export type AdminUser = { id: number; username: string; role: string; createdAt: string };
export type RestoreStatus = {
  phase: "idle" | "queued" | "snapshot" | "restoring" | "rollback" | "done" | "failed";
  active: boolean;
  file: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  snapshot: string | null;
  error: string | null;
  message: string | null;
  sessionsDropped: number;
};
export type AdminOverview = {
  backupCount: number;
  latestBackupFile: string | null;
  latestBackupAt: number | null;
  keepLatest: number;
  frequencyHours: number;
  backupDir: string;
  userCount: number;
  adminCount: number;
  restore: RestoreStatus;
};

export type AdminData = {
  adminOverview: AdminOverview;
  adminBackups: AdminBackup[];
  adminSettings: AdminSetting[];
  adminUsers: AdminUser[];
};

export function fetchAdmin(): Promise<AdminData> {
  return gql<AdminData>(`query Admin {
    adminOverview {
      backupCount latestBackupFile latestBackupAt keepLatest frequencyHours backupDir
      userCount adminCount
      restore { phase active file startedAt finishedAt snapshot error message sessionsDropped }
    }
    adminBackups { file size mtime }
    adminSettings { key value floor kind }
    adminUsers { id username role createdAt }
  }`);
}

export const adminRunBackup = () =>
  gql<{ adminRunBackup: string }>(`mutation RunBackup { adminRunBackup }`);

export const adminStartRestore = (filename: string) =>
  gql<{ adminStartRestore: boolean }>(
    `mutation StartRestore($filename: String!) { adminStartRestore(filename: $filename) }`,
    { filename },
  );

export const adminSetSetting = (key: string, value: string) =>
  gql<{ adminSetSetting: string }>(
    `mutation SetSetting($key: String!, $value: String!) {
      adminSetSetting(key: $key, value: $value)
    }`,
    { key, value },
  );

export const adminSetUserRole = (userId: number, role: string) =>
  gql<{ adminSetUserRole: string }>(
    `mutation SetRole($userId: Int!, $role: String!) {
      adminSetUserRole(userId: $userId, role: $role)
    }`,
    { userId, role },
  );

export const adminDeleteUser = (userId: number) =>
  gql<{ adminDeleteUser: boolean }>(
    `mutation DeleteUser($userId: Int!) { adminDeleteUser(userId: $userId) }`,
    { userId },
  );

export const adminResetPassword = (userId: number, password: string) =>
  gql<{ adminResetPassword: boolean }>(
    `mutation ResetPassword($userId: Int!, $password: String!) {
      adminResetPassword(userId: $userId, password: $password)
    }`,
    { userId, password },
  );

/* Three REST calls, deliberately outside GraphQL: a multipart upload, a
   binary download, and the progress poll that must answer while mutations
   are 503'd during a restore. */
export async function uploadRestoreDump(file: File): Promise<{ file: string; size: number }> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`${API_BASE}/admin/restore/upload`, {
    method: "POST",
    credentials: "include",
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    file?: string;
    size?: number;
    error?: string;
  };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Upload failed (${response.status}).`);
  }
  return { file: payload.file!, size: payload.size ?? file.size };
}

export async function fetchRestoreStatus(): Promise<RestoreStatus> {
  const response = await fetch(`${API_BASE}/admin/restore/status`, { credentials: "include" });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const payload = (await response.json()) as RestoreStatus & { ok: boolean };
  return payload;
}

export const backupDownloadUrl = (file: string) =>
  `${API_BASE}/admin/backups/${encodeURIComponent(file)}`;

// ---------------- Trashbin (D57) ----------------
export const ytTrashVideos = (videoIds: number[]) =>
  gql<{ ytTrashVideos: number }>(
    `mutation TrashVideos($ids: [Int!]!) { ytTrashVideos(videoIds: $ids) }`,
    { ids: videoIds },
  );

export const ytRestoreVideos = (videoIds: number[]) =>
  gql<{ ytRestoreVideos: number }>(
    `mutation RestoreVideos($ids: [Int!]!) { ytRestoreVideos(videoIds: $ids) }`,
    { ids: videoIds },
  );

export const aniTrashEvents = (eventIds: number[]) =>
  gql<{ aniTrashEvents: number }>(
    `mutation TrashEvents($ids: [Int!]!) { aniTrashEvents(eventIds: $ids) }`,
    { ids: eventIds },
  );

export const aniRestoreEvents = (eventIds: number[]) =>
  gql<{ aniRestoreEvents: number }>(
    `mutation RestoreEvents($ids: [Int!]!) { aniRestoreEvents(eventIds: $ids) }`,
    { ids: eventIds },
  );

export const fetchTrash = () =>
  gql<{
    ytTrash: Array<{
      id: number; title: string | null; url: string | null; thumbnail: string | null;
      channel: string | null; publishedAt: number | null; trashedAt: number;
    }>;
    aniTrash: Array<{
      id: number; entryId: number; seasonNo: number | null; kind: string;
      title: string | null; cover: string | null; payload: string;
      createdAt: string; trashedAt: number;
    }>;
  }>(
    `query Trash {
      ytTrash { id title url thumbnail channel publishedAt trashedAt }
      aniTrash { id entryId seasonNo kind title cover payload createdAt trashedAt }
    }`,
  );

// ---------------- Extension tokens (D55) + portable backup (D56) ----------------
export const extIssueToken = () =>
  gql<{ extIssueToken: string }>(`mutation IssueToken { extIssueToken }`);

export const extRevokeToken = () =>
  gql<{ extRevokeToken: boolean }>(`mutation RevokeToken { extRevokeToken }`);

export const extDomains = () =>
  gql<{ extDomains: ExtDomain[] }>(`query ExtDomains { extDomains { id domain media enabled } }`);

export const extAddDomain = (domain: string, media: string) =>
  gql<{ extAddDomain: ExtDomain }>(
    `mutation ExtAddDomain($domain: String!, $media: String!) {
      extAddDomain(domain: $domain, media: $media) { id domain media enabled }
    }`,
    { domain, media },
  );

export const extSetDomainEnabled = (domainId: number, enabled: boolean) =>
  gql<{ extSetDomainEnabled: boolean }>(
    `mutation ExtSetDomainEnabled($id: Int!, $enabled: Boolean!) {
      extSetDomainEnabled(domainId: $id, enabled: $enabled)
    }`,
    { id: domainId, enabled },
  );

export const extRemoveDomain = (domainId: number) =>
  gql<{ extRemoveDomain: boolean }>(
    `mutation ExtRemoveDomain($id: Int!) { extRemoveDomain(domainId: $id) }`,
    { id: domainId },
  );

export const extLearnedSites = () =>
  gql<{ extLearnedSites: ExtLearnedSite[] }>(
    `query ExtLearnedSites {
      extLearnedSites { id entryId entryTitle domain url season episode useCount lastUsedAt }
    }`,
  );

export const extDeleteLearnedSite = (siteId: number) =>
  gql<{ extDeleteLearnedSite: boolean }>(
    `mutation ExtDeleteLearnedSite($id: Int!) { extDeleteLearnedSite(siteId: $id) }`,
    { id: siteId },
  );

export const exportData = () =>
  gql<{ exportData: string }>(`query ExportData { exportData }`);

export const aniWatchLink = (eventId: number) =>
  gql<{ aniWatchLink: string | null }>(
    `query AniWatchLink($id: Int!) { aniWatchLink(eventId: $id) }`,
    { id: eventId },
  );

export const exportCsv = (media: "yt" | "ani") =>
  gql<{ exportCsv: string }>(
    `query ExportCsv($media: String!) { exportCsv(media: $media) }`,
    { media },
  );

export const importCsv = (media: "yt" | "ani", payload: string) =>
  gql<{ importCsv: { imported: number; skipped: number; errors: string[] } }>(
    `mutation ImportCsv($media: String!, $payload: String!) {
      importCsv(media: $media, payload: $payload) { imported skipped errors }
    }`,
    { media, payload },
  );

export const importData = (payload: string) =>
  gql<{ importData: { channels: number; cards: number; anime: number; skipped: number } }>(
    `mutation ImportData($payload: String!) {
      importData(payload: $payload) { channels cards anime skipped }
    }`,
    { payload },
  );
