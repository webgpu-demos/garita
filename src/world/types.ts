// Interfaces between the parts of the scene. engine.ts wires them; each part lives in its own file(s).
import type * as THREE from 'three';
import type { CameraView, FlyTo } from '../core/state';

export interface Frame {
  dt: number;        // seconds since the previous frame, clamped to 0.1
  now: number;       // seconds since start (real time, for animation)
  time: number;      // scene clock, epoch ms (drives sun, moon, tide)
  index: number;
}

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Unit vector from the ground toward the sun / moon in the world frame (x east, y up, z south). Written by post. */
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** 0 = full day, 1 = full night. Written by post. */
  night: number;
  /** Metres above mean sea level the ocean surface is drawn at (tide + scenario). */
  seaLevel: number;
  terrain: TerrainApi;
  post: PostApi;
  controls: ControlsApi;
}

export interface OverlaySource {
  id: string;
  /** XYZ Web Mercator tile URL, or null where there is no tile. Tiles must be CORS-readable images. */
  url(z: number, x: number, y: number): string | null;
  minZoom: number;
  maxZoom: number;       // deeper terrain tiles reuse the maxZoom ancestor
  tileSize?: 256 | 512;
  /** The overlay shows something in the air (rain, cloud), so it must stay visible over the sea instead of being
   *  absorbed by the water like a decal on the seabed. The terrain marks its coverage in the colour buffer's alpha
   *  (alpha = 1 - coverage); the ocean pass mixes the pre-water colour back by that coverage. */
  aboveWater?: boolean;
  /** Tiles drawn in the browser instead of fetched (choropleths): return a canvas or bitmap for the tile, or null. When present, url() is not called. */
  draw?(z: number, x: number, y: number): Promise<TexImageSource | null> | TexImageSource | null;
}

export interface TerrainApi {
  /** Everything the terrain draws, already curved. */
  group: THREE.Object3D;
  update(frame: Frame): void;
  /** Ground elevation in metres above MSL (negative = seabed) from the best tile loaded at (x, z). No curvature. null outside coverage. */
  heightAt(x: number, z: number): number | null;
  /** First hit of a world-space ray with the rendered (curved) terrain, or null. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist?: number): THREE.Vector3 | null;
  /** One raster overlay draped over the photo, or null to clear. */
  setOverlay(source: OverlaySource | null, opacity: number): void;
  /** Shader tint computed from the elevation itself: 'elevation' = hypsometric colours over a muted photo. */
  setTint?(mode: 'none' | 'elevation'): void;
  stats(): { tiles: number; pending: number; maxZoom: number; degraded?: number; imgDown?: boolean; demDown?: boolean };
  dispose(): void;
}

export interface PostApi {
  /** Draws the whole frame: scene, ocean, sky, clouds, tone mapping. */
  render(frame: Frame): void;
  resize(width: number, height: number, dpr: number): void;
  /** Places the sun and moon for a moment in time; drives lights, sky and exposure. */
  setTime(epochMs: number): void;
  setSeaLevel(metres: number): void;
  dispose(): void;
}

export interface ControlsApi {
  /** Point on the ground the camera looks at. */
  target: THREE.Vector3;
  enabled: boolean;
  update(frame: Frame): void;
  flyTo(v: FlyTo): void;
  view(): CameraView;
  dispose(): void;
}
