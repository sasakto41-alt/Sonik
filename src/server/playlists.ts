import * as path from 'path';
import { Playlist, VideoPlaylist } from '../shared/types';
import { JsonStore } from './store';
import { AppPaths } from './paths';
import { uuid } from './util';

interface PlaylistsDb { playlists: Playlist[] }
interface VideoPlaylistsDb { playlists: VideoPlaylist[] }

export class PlaylistManager {
  private musicDb: JsonStore<PlaylistsDb>;
  private videoDb: JsonStore<VideoPlaylistsDb>;

  constructor(paths: AppPaths) {
    this.musicDb = new JsonStore<PlaylistsDb>(path.join(paths.playlists, 'playlists.json'), { playlists: [] }, 300);
    this.videoDb = new JsonStore<VideoPlaylistsDb>(path.join(paths.database, 'video-playlists.json'), { playlists: [] }, 300);
  }

  saveNow(): void { this.musicDb.saveNow(); this.videoDb.saveNow(); }

  // ─── Музыкальные плейлисты ───

  listMusic(): Playlist[] { return this.musicDb.data.playlists; }
  musicById(id: string): Playlist | undefined { return this.musicDb.data.playlists.find(p => p.id === id); }

  createMusic(name: string): Playlist {
    const pl: Playlist = { id: uuid(), name: name.trim() || 'Новый плейлист', trackIds: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.musicDb.data.playlists.push(pl);
    this.musicDb.scheduleSave();
    return pl;
  }

  updateMusic(id: string, patch: { name?: string; trackIds?: string[] }): Playlist | undefined {
    const pl = this.musicById(id);
    if (!pl) return undefined;
    if (typeof patch.name === 'string' && patch.name.trim()) pl.name = patch.name.trim();
    if (Array.isArray(patch.trackIds)) pl.trackIds = patch.trackIds.filter(x => typeof x === 'string');
    pl.updatedAt = Date.now();
    this.musicDb.scheduleSave();
    return pl;
  }

  deleteMusic(id: string): boolean {
    const i = this.musicDb.data.playlists.findIndex(p => p.id === id);
    if (i < 0) return false;
    this.musicDb.data.playlists.splice(i, 1);
    this.musicDb.scheduleSave();
    return true;
  }

  // ─── Плейлисты видео ───

  listVideo(): VideoPlaylist[] { return this.videoDb.data.playlists; }
  videoById(id: string): VideoPlaylist | undefined { return this.videoDb.data.playlists.find(p => p.id === id); }

  createVideo(name: string): VideoPlaylist {
    const pl: VideoPlaylist = { id: uuid(), name: name.trim() || 'Новый плейлист', videoIds: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.videoDb.data.playlists.push(pl);
    this.videoDb.scheduleSave();
    return pl;
  }

  updateVideo(id: string, patch: { name?: string; videoIds?: string[] }): VideoPlaylist | undefined {
    const pl = this.videoById(id);
    if (!pl) return undefined;
    if (typeof patch.name === 'string' && patch.name.trim()) pl.name = patch.name.trim();
    if (Array.isArray(patch.videoIds)) pl.videoIds = patch.videoIds.filter(x => typeof x === 'string');
    pl.updatedAt = Date.now();
    this.videoDb.scheduleSave();
    return pl;
  }

  deleteVideo(id: string): boolean {
    const i = this.videoDb.data.playlists.findIndex(p => p.id === id);
    if (i < 0) return false;
    this.videoDb.data.playlists.splice(i, 1);
    this.videoDb.scheduleSave();
    return true;
  }
}
