import { h, clear, fmtTime, emptyState, spinner, toast } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl, isElectron } from '../api';
import { Track, VideoItem, HistoryEntry } from '../../shared/types';
import { navigate } from '../main';
import { snapshotListener } from '../components';
import { createQuickSection, loadQuickData, QuickSection } from './quick';

/**
 * Главный экран.
 * - в приложении (компьютер): дашборд — плитки быстрого доступа прямо здесь,
 *   приветствие, недавние треки/видео; плеер всегда виден внизу окна,
 *   поэтому работать можно с одного экрана, без переходов по разделам;
 * - в браузере (телефон): приветствие и недавний контент.
 */
export function mountHome(container: HTMLElement): { teardown?: () => void } | void {
  if (isElectron()) return mountDesktopHome(container);

  clear(container);
  container.append(spinner());

  const off = snapshotListener(async (s) => {
    off();
    clear(container);

    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

    const hero = h('div', { class: 'home-hero' },
      h('div', { class: 'home-greeting' }, greeting + '!'),
      h('div', { class: 'home-sub' },
        'Вы подключены с удалённого устройства. Управляйте воспроизведением на компьютере.'));

    const quick = h('div', { class: 'quick-actions' });
    const actions: Array<{ label: string; icon: string; onClick: () => void }> = [
      { label: 'Сценический вывод', icon: 'stage', onClick: () => navigate('stage') },
      { label: 'Soundboard', icon: 'soundboard', onClick: () => navigate('soundboard') },
      { label: 'Визуализация', icon: 'visualizer', onClick: () => navigate('visualizer') }
    ];
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
          'Импортируйте файлы или папки в приложении на компьютере.',
          { label: 'Перейти к музыке', onClick: () => navigate('music') }));
      }
    } catch { /* ошибки сети уже показаны */ }
  });

  return { teardown: () => off() };
}

/** Главный экран в приложении: дашборд с плитками + приветственный контент. */
function mountDesktopHome(container: HTMLElement): { teardown: () => void } {
  clear(container);
  container.append(spinner());

  const sections: QuickSection[] = [];
  let disposed = false;

  async function enableQuick(): Promise<void> {
    try {
      await api.put('/api/quick', { enabled: true });
      toast('success', 'Быстрый доступ включён');
      navigate('home'); // перерисовать главный экран с плитками
    } catch { /* тост из api */ }
  }

  const off = snapshotListener(async (s) => {
    off();
    if (disposed) return;
    clear(container);

    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

    const hero = h('div', { class: 'home-hero' },
      h('div', { class: 'home-greeting' }, greeting + '!'),
      h('div', { class: 'home-sub' },
        'Всё управление на одном экране: плитки ниже, а название трека, плей/пауза и громкость — в панели плеера внизу окна.'));

    container.append(hero);

    // ─── Блок быстрого доступа (плитки) ───
    try {
      const data = await loadQuickData();
      if (disposed) return;
      if (data.config.enabled) {
        const sec = createQuickSection(data.config, {
          tracks: data.tracks, playlists: data.playlists, sounds: data.sounds
        });
        sections.push(sec);
        container.append(sec.root);
      } else {
        container.append(h('div', { class: 'card dash-enable' },
          h('div', {},
            h('div', { class: 'card-title' }, 'Быстрый доступ выключен'),
            h('div', { class: 'muted' },
              'Включите плитки — и соберите свои действия, треки, плейлисты, звуки и команды прямо на главном экране, без переходов по разделам.')),
          h('button', { class: 'btn accent', onclick: () => void enableQuick() }, 'Включить')));
      }
    } catch {
      container.append(h('div', { class: 'card' },
        h('div', { class: 'muted' }, 'Не удалось загрузить конфигурацию быстрого доступа.')));
    }

    // ─── Быстрые действия (импорт и разделы) ───
    const quick = h('div', { class: 'quick-actions' });
    const actions: Array<{ label: string; icon: string; onClick: () => void }> = [
      { label: 'Сценический вывод', icon: 'stage', onClick: () => navigate('stage') },
      { label: 'Soundboard', icon: 'soundboard', onClick: () => navigate('soundboard') },
      { label: 'Визуализация', icon: 'visualizer', onClick: () => navigate('visualizer') },
      { label: 'Импорт музыки', icon: 'folderPlus', onClick: () => navigate('music') },
      { label: 'Импорт видео', icon: 'video', onClick: () => navigate('videos') }
    ];
    for (const a of actions) {
      quick.append(h('button', { class: 'quick-card', onclick: a.onClick },
        h('span', { class: 'quick-icon', html: icon(a.icon) }),
        h('span', { class: 'quick-label' }, a.label)));
    }
    container.append(quick);

    // ─── Недавно прослушанные и избранное ───
    try {
      const hist = await api.get<{ items: HistoryEntry[] }>('/api/music/history');
      const tracksResp = await api.get<{ tracks: Track[] }>('/api/music/tracks');
      if (disposed) return;
      const byId = new Map(tracksResp.tracks.map(t => [t.id, t]));
      const recent = hist.items.slice(0, 6).map(x => byId.get(x.id)).filter((t): t is Track => Boolean(t));
      if (recent.length > 0) {
        container.append(sectionTitle('Недавно прослушано', 'music'));
        const row = h('div', { class: 'card-grid' });
        for (const t of recent) row.append(trackCard(t));
        container.append(row);
      }
      const fav = tracksResp.tracks.filter(t => t.favorite).slice(0, 6);
      if (fav.length > 0) {
        container.append(sectionTitle('Избранное', 'music'));
        const row = h('div', { class: 'card-grid' });
        for (const t of fav) row.append(trackCard(t));
        container.append(row);
      }
      if (tracksResp.tracks.length === 0) {
        container.append(emptyState(ICONS.music, 'Библиотека музыки пуста',
          'Импортируйте файлы или папки, затем добавьте любимые треки плитками на главный экран.',
          { label: 'Перейти к музыке', onClick: () => navigate('music') }));
      }
    } catch { /* ошибки сети уже показаны */ }

    // ─── Недавние видео ───
    try {
      const videos = await api.get<{ videos: VideoItem[] }>('/api/videos');
      if (disposed) return;
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

    // ─── Сервер и доступ ───
    const serverCard = h('div', { class: 'card server-card' },
      h('div', { class: 'card-title' }, 'Сервер и доступ'),
      h('div', { class: 'server-row' },
        h('span', { class: 'muted' }, 'Локальный адрес:'),
        h('code', { class: 'addr' }, s.system.url)),
      h('div', { class: 'server-row' },
        h('span', { class: 'muted' }, 'Сеть:'),
        h('span', {}, s.system.lanEnabled ? `включена — ${s.system.lanUrl}` : 'только этот компьютер'),
        h('button', { class: 'btn ghost small', onclick: () => navigate('settings') }, 'Настроить')));
    container.append(serverCard);
  });

  return {
    teardown: () => {
      disposed = true;
      off();
      for (const sec of sections) sec.teardown();
    }
  };
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
