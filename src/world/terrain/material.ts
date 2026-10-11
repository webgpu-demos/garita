// Tile material: MeshStandardMaterial (so the sun, hemisphere light and scene.environment all apply) with the
// albedo, normal and seabed logic patched in. One GLSL program is shared by every tile.
import * as THREE from 'three';

export interface TileUniforms {
  tPhoto: { value: THREE.Texture };
  tNorm: { value: THREE.Texture };       // RG = world normal x,z; B = height code: e = B*2 - 1, metres = sign(e) e^2 96; A = water / built-up
  tOverlay: { value: THREE.Texture };
  uOvXf: { value: THREE.Vector4 };
  uHasPhoto: { value: number };
  uTint: { value: THREE.Color };
  uDenXf: { value: THREE.Vector4 };      // tile uv -> building-density texture uv
}
export interface GlobalUniforms {
  uOvOpacity: { value: number }; uRelief: { value: number }; uLod: { value: number };
  uNight: { value: number }; uTintMode: { value: number }; uLightGain: { value: number }; uOvEmit: { value: number };
  uOvAbove: { value: number }; tDensity: { value: THREE.Texture };
}

const PARS = /* glsl */`
uniform sampler2D tPhoto; uniform sampler2D tNorm; uniform sampler2D tOverlay;
uniform vec4 uOvXf; uniform float uHasPhoto; uniform float uOvOpacity; uniform float uRelief; uniform float uLod; uniform vec3 uTint;
uniform float uNight; uniform float uTintMode; uniform float uLightGain; uniform float uOvEmit; uniform float uOvAbove; uniform sampler2D tDensity; uniform vec4 uDenXf;
varying float vH; varying vec2 vWxz;
vec3 gEmit; float gOvCov;
vec3 gToLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
float gHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec3 gHypso(float h) {
  vec3 c;
  if (h < 0.0) {
    float d = -h;
    c = mix(vec3(0.60, 0.84, 0.90), vec3(0.27, 0.58, 0.80), smoothstep(0.0, 60.0, d));
    c = mix(c, vec3(0.09, 0.25, 0.52), smoothstep(60.0, 2000.0, d));
    c = mix(c, vec3(0.03, 0.08, 0.26), smoothstep(2000.0, 8000.0, d));
  } else {
    c = mix(vec3(0.13, 0.40, 0.20), vec3(0.36, 0.57, 0.25), smoothstep(0.0, 150.0, h));
    c = mix(c, vec3(0.78, 0.74, 0.44), smoothstep(150.0, 450.0, h));
    c = mix(c, vec3(0.68, 0.52, 0.36), smoothstep(450.0, 850.0, h));
    c = mix(c, vec3(0.95, 0.93, 0.88), smoothstep(850.0, 1300.0, h));
  }
  return gToLin(c);
}
`;

const ALBEDO = /* glsl */`
{
  vec4 nt = texture2D(tNorm, vUv);
  float hE = nt.b * 2.0 - 1.0;
  float hC = sign(hE) * hE * hE * 96.0;
  float h = hC < -95.0 ? min(hC, vH) : (hC > 95.0 ? max(hC, vH) : hC);
  // Alpha is the photo's coverage (0 in the blank white/black blocks the service paints outside its footprint);
  // blank pixels are stored black, so rgb / alpha is the picture's own colour right up to the block edge.
  vec4 ph = texture2D(tPhoto, vUv, -0.35);
  float cov = smoothstep(0.30, 0.85, ph.a) * uHasPhoto;
  vec3 lin = ph.rgb / max(ph.a, 0.08);
  // Grade in display space: the aerial photo carries a blue haze veil and crushed shadows.
  vec3 s = pow(max(lin, 0.0), vec3(1.0 / 2.2));
  s = max(s - vec3(0.020, 0.034, 0.062), 0.0) * 1.11;
  float warm = max(s.r, s.g);
  if (s.b > warm) s.b = warm + (s.b - warm) * 0.45;
  float l = dot(s, vec3(0.30, 0.59, 0.11));
  float l2 = 0.035 + 0.965 * l;
  s = clamp(l2 + (s - l) * 1.16, 0.0, 1.0);
  vec3 land = gToLin(s);
  {
    // No photo here: colour by elevation so the page never shows a slab.
    float t = clamp(h / 1200.0, 0.0, 1.0);
    vec3 c = mix(vec3(0.33, 0.42, 0.22), vec3(0.20, 0.33, 0.15), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(0.42, 0.40, 0.30), smoothstep(0.55, 1.0, t));
    land = mix(gToLin(c), land, cov); l = mix(0.45, l, cov);
  }
  float wat = clamp(1.0 - nt.a * 2.0, 0.0, 1.0), built = clamp(nt.a * 2.0 - 1.0, 0.0, 1.0) * cov;
  // Seabed for the ocean pass to tint: wherever the merged model is under the sea. Only where there is no topo-bathy
  // (the worker clears the water flag where there is) does the photo decide at sea level: water or nothing in the
  // picture = seabed. Lagoons, piers, the port and mangrove at 0 m keep their photo.
  float depth = max(0.0, -h);
  float shallow = 1.0 - smoothstep(0.0, 25.0, depth);
  // Sand against seagrass is read off the photo only where the water is shallow enough for it to show the real
  // bottom; deeper, plumes, glint and mosaic seams would print themselves on the seabed.
  float clearW = (1.0 - smoothstep(1.5, 7.0, depth)) * cov;
  float veg = mix(0.38, smoothstep(0.44, 0.10, l), clearW) * shallow;
  float grain = gHash(floor(vWxz / 40.0)) * 0.5 + gHash(floor(vWxz / 190.0)) * 0.5;
  vec3 bed = mix(vec3(0.60, 0.56, 0.45), vec3(0.50, 0.47, 0.39), grain);
  bed = mix(bed, vec3(0.13, 0.17, 0.11), veg * 0.75);
  bed = mix(bed, vec3(0.20, 0.20, 0.19), smoothstep(20.0, 70.0, depth));
  float low = 1.0 - smoothstep(0.25, 0.7, h);
  // The first metre of water keeps the photo (it shows that water: surf, a turbid pond, the wet edge of a marsh);
  // a blank photo has nothing to show, so there the seabed starts at the waterline.
  float deepen = mix(smoothstep(-0.25, -1.25, h), smoothstep(-0.05, -0.35, h), 1.0 - cov);
  float under = max(deepen, low * smoothstep(0.3, 0.6, wat));
  vec3 alb = mix(land, bed, under);
  if (uTintMode > 0.5) {
    float hh = (hC < -95.0 || hC > 95.0) ? vH : h;
    float g = dot(land, vec3(0.30, 0.59, 0.11));
    alb = gHypso(hh) * clamp(0.50 + 2.4 * mix(0.2, g, 1.0 - under), 0.35, 1.5);
  }
  vec2 ouv = vUv * uOvXf.xy + uOvXf.zw;
  vec4 ov = texture2D(tOverlay, ouv);
  vec3 ovLin = gToLin(pow(ov.rgb, vec3(1.0 / 2.2)));
  alb = mix(alb, ovLin, ov.a * uOvOpacity);
  gOvCov = ov.a * uOvOpacity;
  alb = mix(alb, alb * 0.35 + uTint * 0.65, uLod);
  diffuseColor.rgb = alb;
  // Town lights: built-up surface in the photo emits a sodium/LED mix, as points close up and as a glow from afar.
  // An image of light (satellite night lights) shows by its own light after dark: as a surface colour under
  // the night's dim light it would be nearly black.
  gEmit = ovLin * (ov.a * uOvOpacity * uOvEmit);
  if (uNight > 0.01) {
    // Building density (buildings per zoom-14 tile, baked at start) decides where the lights are; the photo decides
    // their fine pattern. Dense metro glows, the Cordillera is dark with scattered points.
    float den = texture2D(tDensity, vUv * uDenXf.xy + uDenXf.zw).r;
    float wd = smoothstep(0.04, 0.60, den);
    float lit = (built * (0.55 + 0.45 * wd) + 0.04 * wd) * smoothstep(1.2, 3.5, h) * (1.0 - under);
    vec2 cell = vWxz / 30.0, ci = floor(cell), cf = fract(cell) - 0.5;
    float r1 = gHash(ci), r2 = gHash(ci + 71.7);
    vec2 off = (vec2(r2, fract(r2 * 7.31)) - 0.5) * 0.55;
    float p = mix(0.02, 0.28, wd);
    float pt = step(1.0 - p, r1) * smoothstep(0.42, 0.04, length(cf - off)) * 5.0;
    float fw = max(length(dFdx(vWxz)), length(dFdy(vWxz)));
    float far = smoothstep(7.0, 40.0, fw);
    vec3 col = mix(mix(vec3(1.0, 0.56, 0.22), vec3(0.92, 0.90, 0.80), step(0.68, r2)), vec3(1.0, 0.68, 0.38), far);
    // (the glow is at full strength only from far enough that a pixel covers a block: closer, it would wash the
    //  whole built-up area in one flat cream instead of leaving dark ground between lights)
    float glow = (0.12 + 1.7 * wd) * mix(0.12, 1.0, smoothstep(40.0, 250.0, fw));   // (0.12: about the mean of the points it replaces)
    gEmit += col * lit * mix(pt * (0.30 + 0.70 * wd), glow, far) * uNight * uLightGain * (1.0 - ov.a * uOvOpacity * 0.7);
  }
}
`;

const NORMAL = /* glsl */`
{
  vec2 nxz = texture2D(tNorm, vUv).rg * 2.0 - 1.0;
  // The photo already holds the real sun's shading, so the lit response is softened: horizontal part scaled down.
  nxz *= uRelief;
  vec3 nW = vec3(nxz.x, sqrt(max(0.05, 1.0 - dot(nxz, nxz))), nxz.y);
  normal = normalize(mat3(viewMatrix) * normalize(nW));
  nonPerturbedNormal = normal;
}
`;

const LOD_COLORS = [0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x46f0f0, 0xf032e6, 0xbcf60c, 0xfabebe];

export function makeTileMaterial(g: GlobalUniforms, photo: THREE.Texture, norm: THREE.Texture, overlay: THREE.Texture, hasPhoto: boolean, z: number) {
  const uniforms: TileUniforms = {
    tPhoto: { value: photo }, tNorm: { value: norm }, tOverlay: { value: overlay },
    uOvXf: { value: new THREE.Vector4(1, 1, 0, 0) }, uHasPhoto: { value: hasPhoto ? 1 : 0 },
    uTint: { value: new THREE.Color(LOD_COLORS[z % LOD_COLORS.length]) },
    uDenXf: { value: new THREE.Vector4(1, 1, 0, 0) },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, color: 0xffffff });
  material.defines = { USE_UV: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, g);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vH; varying vec2 vWxz;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { vec4 wp = modelMatrix * vec4(transformed, 1.0); vH = wp.y + (wp.x * wp.x + wp.z * wp.z) / (2.0 * 6371008.8); vWxz = wp.xz; }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <map_fragment>', ALBEDO)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gEmit;')
      // Overlays in the air (radar, cloud) mark their coverage in alpha so the ocean pass keeps them above the water.
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor.a = 1.0 - gOvCov * uOvAbove;')
      .replace('#include <normal_fragment_maps>', NORMAL);
  };
  material.customProgramCacheKey = () => 'garita-tile-14';
  return { material, uniforms };
}
