import { h, clear, el, fmtTime, emptyState, spinner } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl, isElectron } from '../api';
import { Track, VideoItem, HistoryEntry } from '../../shared/types';
import { navigate } from '../main';
import { snapshotListener } from '../components';

/**
 * Главная: приветствие, быстрые действия, недавние треки/видео, избранное.
 */
export function mountHome(container: HTMLElement): void {
  clear(container);
  container.append(spinner());

  const off = snapshotListener(async (s) => {
    off();
    clear(container);

    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

    const hero = h('div', { class: 'home-hero' },
      h('div', { class: 'home-greeting' }, greeting + '!'),
      h('div', { class: 'home-sub' }, s.system.electron
        ? 'Музыкальный центр, видео и сценический вывод — всё в одном месте.'
        : 'Вы подключены с удалённого устройства. Управляйте воспроизведением на компьютере.'));

    const quick = h('div', { class: 'quick-actions' });
    const actions: Array<{ label: string; icon: string; onClick: () => void }> = [
      { label: 'Сценический вывод', icon: 'stage', onClick: () => navigate('stage') },
      { label: 'Soundboard', icon: 'soundboard', onClick: () => navigate('soundboard') },
      { label: 'Визуализация', icon: 'visualizer', onClick: () => navigate('visualizer') }
    ];
    if (isElectron()) {
      actions.unshift({ label: 'Импорт музыки', icon: 'folderPlus', onClick: () => navigate('music') });
      actions.splice(1, 0, { label: 'Импорт видео', icon: 'video', onClick: () => navigate('videos') });
    }
    for (const a of actions) {
      quick.append(h('button', { class: 'quick-card', onclick: a.onClick },
        h('span', { class: 'quick-icon', html: icon(a.icon) }),
        h('span', { class: 'quick-label' }, a.label)));
    }

    // Статус сервера
    const serverCard = h('div', { class: 'card server-card' },
      h('div', { class: 'card-title' }, 'Сервер и доступ'),
      h('div', { class: 'server-row' },
        h('span', { class: 'muted' }, 'Локальный адрес:'),
        h('code', { class: 'addr' }, s.system.url)),
      h('div', { class: 'server-row' },
        h('span', { class: 'muted' }, 'Сеть:'),
        h('span', {}, s.system.lanEnabled ? `включена — ${s.system.lanUrl}` : 'только этот компьютер'),
        h('button', { class: 'btn ghost small', onclick: () => navigate('settings') }, 'Настроить')));

    container.append(hero, quick, serverCard);

    // Недавно прослушанные треки
    try {
      const hist = await api.get<{ items: HistoryEntry[] }>('/api/music/history');
      const tracksResp = await api.get<{ tracks: Track[] }>('/api/music/tracks');
      const byId = new Map(tracksResp.tracks.map(t => [t.id, t]));
      const recent = hist.items.slice(0, 6).map(x => byId.get(x.id)).filter((t): t is Track => Boolean(t));
      if (recent.length > 0) {
        container.append(sectionTitle('Недавно прослушано', 'music'));
        const row = h('div', { class: 'card-grid' });
        for (const t of recent) row.append(trackCard(t));
        container.append(row);
      }
      // Избранное
      const fav = tracksResp.tracks.filter(t => t.favorite).slice(0, 6);
      if (fav.length > 0) {
        container.append(sectionTitle('Избранное', 'music'));
        const row = h('div', { class: 'card-grid' });
        for (const t of fav) row.append(trackCard(t));
        container.append(row);
      }
      // Пустая библиотека
      if (tracksResp.tracks.length === 0) {
        container.append(emptyState(ICONS.music, 'Библиотека музыки пуста',
          'Импортируйте файлы или папки в разделе «Музыка».',
          { label: 'Перейти к музыке', onClick: () => navigate('music') }));
      }
    } catch { /* ошибки сети уже показаны */ }

    // Недавние видео
    try {
      const videos = await api.get<{ videos: VideoItem[] }>('/api/videos');
      const recentVideos = [...videos.videos]
        .filter(v => v.lastPlayedAt)
        .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
        .slice(0, 6);
      if (recentVideos.length > 0) {
        container.append(sectionTitle('Недавние видео', 'video'));
        const row = h('div', { class: 'video-grid' });
        for (const v of recentVideos) row.append(videoCard(v));
        container.append(row);
      }
    } catch { /* ignore */ }
  });
}

export function sectionTitle(title: string, ic = 'music'): HTMLElement {
  return h('div', { class: 'section-title' },
    h('span', { class: 'section-icon', html: icon(ic) }), title);
}

export function trackCard(t: Track): HTMLElement {
  return h('div', { class: 'card track-card' + (t.missing ? ' missing' : '') },
    h('button', { class: 'card-cover', onclick: () => playTrack(t) },
      t.coverFile
        ? h('img', { src: mediaUrl(`/api/music/cover/${t.id}`), alt: '', loading: 'lazy' })
        : h('span', { html: icon('music') }),
      h('span', { class: 'cover-play', html: ICONS.play })),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-name', title: t.title }, t.title + (t.missing ? ' (файл отсутствует)' : '')),
      h('div', { class: 'card-sub' }, `${t.artist}${t.album ? ' · ' + t.album : ''} · ${fmtTime(t.duration)}`)));
}

export function videoCard(v: VideoItem): HTMLElement {
  const c = h('div', { class: 'card video-card' + (v.missing ? ' missing' : '') });
  c.append(h('button', { class: 'card-cover video', onclick: () => navigate('videos') },
    v.thumbFile
      ? h('img', { src: mediaUrl(`/api/videos/thumb/${v.id}`), alt: '', loading: 'lazy' })
      : h('span', { html: icon('video') }),
    h('span', { class: 'duration-badge' }, fmtTime(v.duration))));
  c.append(h('div', { class: 'card-body' },
    h('div', { class: 'card-name', title: v.title }, v.title + (v.missing ? ' (файл отсутствует)' : '')),
    h('div', { class: 'card-sub' }, v.format.toUpperCase())));
  return c;
}

export async function playTrack(t: Track): Promise<void> {
  const { player } = await import('../player');
  const { isElectron } = await import('../api');
  if (isElectron()) await player.playTrack(t.id, [t.id]);
  else await player.remoteCommand('playTrack', { trackId: t.id, queue: [t.id] });
}
