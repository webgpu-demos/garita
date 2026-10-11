// Everything between "geometry is in the scene" and "pixels on screen": sun and moon, scene lights, sky, aerial
// perspective, clouds, the ocean, bloom, tone mapping, anti-aliasing.
//
// Chain:  scene + ocean (ocean.ts)  ->  x UNITS  ->  clouds + aerial perspective (takram)  ->  x exposure / UNITS
//         ->  bloom + tone mapping  ->  SMAA + dither.
// If the physical atmosphere cannot run (set-up throws, a shader fails, ?post=basic) the ocean pass draws an
// analytic sky and haze instead and the rest of the chain is unchanged; if even that fails, a plain render.
import './idle';   // first: see the file
import * as THREE from 'three';
import { EffectComposer, EffectPass, Effect, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, SMAAPreset } from 'postprocessing';
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere';
import { CloudsEffect, CLOUD_SHAPE_TEXTURE_SIZE, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE } from '@takram/three-clouds';
import { DataTextureLoader, Ellipsoid, Geodetic, parseUint8Array, radians, STBNLoader } from '@takram/three-geospatial';
import * as S from '../../core/state';
import { ORIGIN } from '../../core/geo.ts';
import { dataUrl, params } from '../../core/config';
import type { Frame, PostApi, World } from '../types';
import { SceneOceanPass, SKY_GLSL, OVER_WATER_LAYER } from './ocean';

// Scene lights by sun elevation (after procedural-sanjuan's tables). A sunlit white wall is about 1 in scene units.
const DAY = { hemi: 0.45, sun: 3.4, sunColor: new THREE.Color(0xfff0dc), exposure: 0.95, bloom: 0.25 };
const NIGHT = { hemi: 0.10, sun: 0.26, sunColor: new THREE.Color(0x9fb4e0), exposure: 3.2, bloom: 0.5 };   // a readable night (moonlight even at new moon), dark enough that the town lights carry it
const SUNSET = new THREE.Color(0xff9a52);
// Low sun: expose for the sky (a small lift only), more from orbit where the frame is all ground; richer colour.
const LOW = { lift: 0.15, orbit: 0.3, sat: 0.2, curve: 0.3, darkPow: 2.0, shadows: 0.11 };
// What flat ground receives, (sky fill + sun or moon on a horizontal surface) x exposure, never falls below this
// between day and night. A night under a high full moon reaches about 2.3, noon about 3.3; without the floor, dusk and dawn (sun
// grazing and dimmed, exposure still set for the bright sky) sat near 1.0: darker than the night that follows.
const GROUND_FLOOR = 2.3;
const HEMI_SKY = new THREE.Color(0xcfe2ff), HEMI_DUSK = new THREE.Color(0xf1d9cb);
// Scene radiance -> the atmosphere's units. The takram sun delivers solarIrradiance (1.47, 1.85, 1.91) x transmittance
// (about 0.8 at noon) on the ground, so its sunlit white wall is ~1.43 / pi; ours is DAY.sun / pi.
const UNITS = +(params.get('units') ?? 0) || 1.43 / DAY.sun;
const SHADE = 0.45;   // what is left of a surface's light under a thick cloud
const ASSETS = 'assets-static/takram';
const off = (name: string) => params.get(name) === '0';

class Scale extends Effect {
  constructor(k: number) {
    // Capped: the sun's disc would otherwise bloom into a white blob. Not-a-number and infinite pixels are zeroed:
    // one of them (the sky shader makes a few at the horizon under a low sun) spreads through the bloom's blur
    // pyramid and blacks out the whole frame.
    super('Scale', `uniform float k; void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb * k;
        if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
        outputColor = vec4(clamp(c, vec3(0.0), vec3(48.0)), inputColor.a); }`,
      { uniforms: new Map([['k', new THREE.Uniform(k)]]) });
  }
  set k(v: number) { this.uniforms.get('k')!.value = v; }
}

/** After tone mapping (display-linear in): white lift, a soft S-curve and saturation. g = (gain, curve, saturation). */
class Grade extends Effect {
  constructor() {
    super('Grade', `uniform vec3 g; uniform float lift;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = clamp(inputColor.rgb * g.x, 0.0, 1.0);
        vec3 p = pow(c, vec3(1.0 / 2.2));
        p = mix(p, p * p * (3.0 - 2.0 * p), g.y);
        p = pow(p, vec3(1.0 - lift));   // low sun: opens the shadows without moving white
        c = pow(p, vec3(2.2));
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        outputColor = vec4(clamp(mix(vec3(l), c, g.z), 0.0, 1.0), inputColor.a);
      }`, { uniforms: new Map<string, THREE.Uniform>([['g', new THREE.Uniform(new THREE.Vector3(1.1, 0.3, 1.12))], ['lift', new THREE.Uniform(0)]]) });
  }
  get g(): THREE.Vector3 { return this.uniforms.get('g')!.value; }
  set lift(v: number) { this.uniforms.get('lift')!.value = v; }
}

type Mode = 'takram' | 'basic' | 'plain';

export function createPost(world: World): PostApi {
  const { renderer, scene, camera } = world;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  let mode: Mode = 'basic';
  let lutsReady = false, shaderFailed = false, oceanFailed = false, warned = false, wantTakram = params.get('post') !== 'basic' && !off('aerial');
  const warn = (why: unknown) => { if (!warned) { warned = true; console.warn('[garita/post] physical atmosphere unavailable, using the analytic sky fallback:', why); } };

  // ---- lights (owned here)
  const sun = new THREE.DirectionalLight(0xffffff, DAY.sun);
  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x6b6456, DAY.hemi);
  scene.add(sun, sun.target, hemi);
  const lightDir = new THREE.Vector3(0, 1, 0);
  const sRight = new THREE.Vector3(), sUp = new THREE.Vector3(), Y_UP = new THREE.Vector3(0, 1, 0);
  renderer.shadowMap.enabled = true;            // (costs nothing until the sun light casts: see render)
  renderer.shadowMap.type = THREE.PCFShadowMap;   // (soft in this three version)
  sun.shadow.radius = 2;
  sun.shadow.bias = -0.0002;
  sun.shadow.mapSize.set(2048, 2048);
  const st = { elevation: 45, dark: 0, daylight: 1, moonlight: 0, warmth: 0, lowSun: 0, fill: 0, ground: 0, observed: false, exposure: DAY.exposure, bloom: DAY.bloom, shadows: false, shadowExtent: 0 };

  // ---- where the scene sits on the globe: world (east, up, south) -> ECEF
  const ecef = new Geodetic(radians(ORIGIN.lon), radians(ORIGIN.lat), 0).toECEF();
  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  Ellipsoid.WGS84.getEastNorthUpVectors(ecef, east, north, up);
  const worldToECEF = new THREE.Matrix4().makeBasis(east, up, north.clone().negate()).setPosition(ecef);
  const toWorld = new THREE.Matrix3().setFromMatrix4(worldToECEF).transpose();
  const sunE = new THREE.Vector3(), moonE = new THREE.Vector3(), date = new Date();

  // ---- passes
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  const ocean = new SceneOceanPass(scene, camera);
  ocean.uniforms.uOcean.value = off('ocean') ? 0 : 1;
  ocean.uniforms.uDbgAlpha.value = params.get('alpha') === '1' ? 1 : 0;
  ocean.uniforms.uDeepGain.value = +(params.get('deep') ?? 2.0);
  composer.addPass(ocean);
  const scaleIn = new Scale(UNITS), scaleOut = new Scale(1);
  const scaleInPass = new EffectPass(camera, scaleIn);

  const cloudNight = new THREE.Uniform(new THREE.Vector3());   // moonlit clouds: the library gives them no light at night
  const cloudGain = new THREE.Uniform(+(params.get('cg') ?? 1.5));
  const field = new THREE.Uniform(new THREE.Vector4(0.085, 0.3, 0.8, 0.36));   // field frequency factor, clear-lane weather scale, island boost, field threshold
  let aerial: any = null, plain: any = null, clouds: any = null, cloudPass: EffectPass | null = null, skyPass: EffectPass | null = null;
  const wantClouds = !off('clouds');
  if (wantTakram) {
    try {
      const patch = (fx: any) => { // clouds shade the ground although the scene keeps its own lights
        const hook = 'radiance = inputColor.rgb;\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)';
        const src: string = fx.getFragmentShader();
        if (src.includes(hook)) fx.setFragmentShader(src.replace(hook, `radiance = inputColor.rgb * mix(${SHADE.toFixed(2)}, 1.0, (sunTransmittance >= 0.0 && sunTransmittance <= 1.0) ? sunTransmittance : 1.0);\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)`));   // (an invalid shadow value counts as no shadow)
      };
      const make = () => {
        const fx: any = new AerialPerspectiveEffect(camera);
        fx.sky = true; fx.sun = true; fx.moon = true; fx.ground = false;
        fx.worldToECEFMatrix.copy(worldToECEF);
        let src: string = fx.getFragmentShader();
        // the sky is added to what the ocean pass wrote in sky pixels (night sky and stars)
        const skyHook = '    outputColor.a = 1.0;\n    #else // SKY';
        if (src.includes(skyHook)) src = src.replace(skyHook, '    outputColor.rgb += inputColor.rgb;\n' + skyHook);
        // the cloud buffer is brightened: the library's clouds come out darker than sunlit sand in our units
        const ovHook = 'vec4 overlay = texture(overlayBuffer, uv);';
        if (src.includes(ovHook)) { src = src.replace(ovHook, ovHook + '\n  if (any(isnan(overlay)) || any(isinf(overlay))) overlay = vec4(0.0);   // an invalid cloud pixel is no cloud, not a black frame\n  overlay.rgb = overlay.rgb * garitaCloudGain + overlay.a * garitaCloudNight;').replace('uniform sampler2D overlayBuffer;', 'uniform sampler2D overlayBuffer;\nuniform float garitaCloudGain;\nuniform vec3 garitaCloudNight;'); fx.uniforms.set('garitaCloudGain', cloudGain); fx.uniforms.set('garitaCloudNight', cloudNight); }
        fx.setFragmentShader(src);
        return fx;
      };
      plain = make();
      const generator = new PrecomputedTexturesGenerator(renderer);
      generator.update().then(() => { lutsReady = true; }).catch((e: unknown) => { wantTakram = false; warn(e); });
      Object.assign(plain, generator.textures);
      composer.addPass(scaleInPass);
      if (wantClouds) {
        aerial = make(); patch(aerial);
        Object.assign(aerial, generator.textures);
        clouds = new CloudsEffect(camera);
        clouds.worldToECEFMatrix.copy(worldToECEF);
        clouds.localWeatherVelocity.set(0.0006, 0.0002);
        // trade-wind cumulus between 600 m and 2200 m, in cells a few km across
        clouds.cloudLayers[0].set({ altitude: 600, height: 800, densityScale: 0.3 });
        clouds.cloudLayers[1].set({ altitude: 800, height: 1400, densityScale: 0.3 });
        clouds.localWeatherRepeat.setScalar(+(params.get('lw') ?? 60));
        // Cloud FIELDS: a low-frequency copy of the weather map opens clear lanes between fields of cumulus, and
        // there is more over the island's mountains than over open sea (in the cloud pass and in its shadow pass).
        const where = 'vec2 getGlobeUv(const vec3 position) {', mask = '  #ifdef SHADOW\n  localWeather *= shadowLayerMask;';
        for (const material of [clouds.cloudsPass.currentMaterial, clouds.shadowPass.currentMaterial]) {
          const src: string = material.fragmentShader;
          if (!src.includes(where) || !src.includes(mask)) { console.warn('[garita/post] cloud shader changed: no cloud fields'); continue; }
          material.fragmentShader = src
            .replace(where, `uniform vec4 garitaField;\nvec3 garitaPos;\n${where}\n  garitaPos = position;`)
            .replace(mask, `  {
    vec3 gw = (ecefToWorldMatrix * vec4(garitaPos - altitudeCorrection, 1.0)).xyz;
    float gf = textureLod(localWeatherTexture, uv * localWeatherRepeat * garitaField.x + vec2(0.37, 0.61), 0.0).r;
    float gfield = smoothstep(garitaField.w - 0.14, garitaField.w + 0.14, gf);
    float gisland = exp(-(gw.x * gw.x) / (2.0 * 70000.0 * 70000.0) - ((gw.z - 3000.0) * (gw.z - 3000.0)) / (2.0 * 17000.0 * 17000.0));
    localWeather.rg *= mix(garitaField.y, 1.0, gfield) * (1.0 + garitaField.z * gisland);
  }
${mask}`)
            // A pixel that is not a number (a grazing ray at the horizon, the sun under it) must not reach the cloud
            // pass's own history: temporal filtering spreads it one pixel a frame until the whole sky is invalid.
            .replace('outputColor = color;', 'outputColor = (any(isnan(color)) || any(isinf(color))) ? vec4(0.0) : color;')
            .replace('outputDepthVelocity = depthVelocity;', 'outputDepthVelocity = (any(isnan(depthVelocity)) || any(isinf(depthVelocity))) ? vec3(0.0) : depthVelocity;')
            .replace('outputShadowLength = shadowLength * METER_TO_LENGTH_UNIT;', 'outputShadowLength = (isnan(shadowLength) || isinf(shadowLength)) ? 0.0 : shadowLength * METER_TO_LENGTH_UNIT;');
          material.uniforms.garitaField = field;
          material.needsUpdate = true;
        }
        Object.assign(clouds, generator.textures);
        const pass = (property: string) => {
          if (property === 'atmosphereOverlay') aerial.overlay = clouds.atmosphereOverlay;
          else if (property === 'atmosphereShadow') aerial.shadow = clouds.atmosphereShadow;
          else if (property === 'atmosphereShadowLength') aerial.shadowLength = clouds.atmosphereShadowLength;
        };
        clouds.events.addEventListener('change', (e: any) => pass(e.property));
        const repeat = (t: THREE.Texture) => { t.minFilter = THREE.LinearMipMapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; };
        const volume = (size: number) => new (DataTextureLoader as any)(THREE.Data3DTexture, parseUint8Array, {
          width: size, height: size, depth: size, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, wrapR: THREE.RepeatWrapping, colorSpace: THREE.NoColorSpace,
        });
        clouds.localWeatherTexture = new THREE.TextureLoader().load(dataUrl(`${ASSETS}/local_weather.png`), repeat);
        clouds.turbulenceTexture = new THREE.TextureLoader().load(dataUrl(`${ASSETS}/turbulence.png`), repeat);
        clouds.shapeTexture = volume(CLOUD_SHAPE_TEXTURE_SIZE).load(dataUrl(`${ASSETS}/shape.bin`));
        clouds.shapeDetailTexture = volume(CLOUD_SHAPE_DETAIL_TEXTURE_SIZE).load(dataUrl(`${ASSETS}/shape_detail.bin`));
        const stbn = new STBNLoader().load(dataUrl(`${ASSETS}/stbn.bin`));
        clouds.stbnTexture = stbn; aerial.stbnTexture = stbn; plain.stbnTexture = stbn;
        cloudPass = new EffectPass(camera, clouds, aerial);
        cloudPass.enabled = false;
        composer.addPass(cloudPass);
        (['atmosphereOverlay', 'atmosphereShadow', 'atmosphereShadowLength']).forEach(pass);
      }
      skyPass = new EffectPass(camera, plain);
      composer.addPass(skyPass);
    } catch (e) { wantTakram = false; warn(e); }
  }
  composer.addPass(new EffectPass(camera, scaleOut));
  const bloom = new BloomEffect({ intensity: DAY.bloom, luminanceThreshold: 1.0, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.7 });
  const tone = new ToneMappingEffect({ mode: params.get('tm') === 'aces' ? ToneMappingMode.ACES_FILMIC : params.get('tm') === 'neutral' ? ToneMappingMode.NEUTRAL : ToneMappingMode.AGX });
  const grade = new Grade();
  composer.addPass(new EffectPass(camera, bloom, tone, grade));
  const aaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }));
  (aaPass as any).dithering = true;
  composer.addPass(aaPass);

  const prevOnShaderError = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    shaderFailed = true;
    if ((gl.getShaderSource(fs) || '').includes('uDeepGain')) oceanFailed = true;
    console.warn('[garita/post] shader failed:', (gl.getProgramInfoLog(program) || '').slice(0, 300), (gl.getShaderInfoLog(fs) || '').slice(0, 600), (gl.getShaderInfoLog(vs) || '').slice(0, 300));
  };

  // ---- environment map: the analytic sky, re-baked when the sun has moved
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyU = ocean.uniforms;
  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, toneMapped: false,
    uniforms: { uZen: skyU.uZen, uHor: skyU.uHor, uGlow: skyU.uGlow, uSunDir: skyU.uSunDir },
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir; ${SKY_GLSL} void main() { vec3 d = normalize(vDir); vec3 c = d.y >= 0.0 ? skyRad(d, d.y) : mix(uHor, vec3(0.02, 0.05, 0.07), smoothstep(0.0, -0.25, d.y)); gl_FragColor = vec4(c, 1.0); }`,
  });
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envMat));
  const bakedSun = new THREE.Vector3(0, -2, 0);
  let envRT: THREE.WebGLRenderTarget | null = null;
  const bakeEnv = () => {
    const old = envRT;
    envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
    scene.environment = envRT.texture;
    old?.dispose();
    bakedSun.copy(world.sunDir);
  };

  const sstep = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp;
  const cDayZen = new THREE.Vector3(0.050, 0.115, 0.30), cDayHor = new THREE.Vector3(0.34, 0.42, 0.53);
  const cDuskZen = new THREE.Vector3(0.022, 0.040, 0.105), cDuskHor = new THREE.Vector3(0.46, 0.27, 0.13);
  const cNightZen = new THREE.Vector3(0.0040, 0.0062, 0.0140), cNightHor = new THREE.Vector3(0.0090, 0.0120, 0.0200);
  const tmpC = new THREE.Color();

  function setTime(epochMs: number): void {
    date.setTime(epochMs);
    getSunDirectionECEF(date, sunE);
    getMoonDirectionECEF(date, moonE);
    world.sunDir.copy(sunE).applyMatrix3(toWorld).normalize();
    world.moonDir.copy(moonE).applyMatrix3(toWorld).normalize();
    for (const fx of [aerial, plain]) if (fx) { fx.sunDirection.copy(sunE); fx.moonDirection.copy(moonE); }
    if (clouds) clouds.sunDirection.copy(sunE);

    const deg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(world.sunDir.y, -1, 1)));
    st.elevation = deg;
    st.dark = 1 - sstep(deg, -13, 5);
    st.daylight = sstep(deg, -5, 9);
    st.moonlight = 1 - sstep(deg, -14, -5.5);
    st.warmth = 1 - sstep(deg, 3, 24);
    world.night = st.dark;
    const moonUp = sstep(world.moonDir.y, 0.0, 0.25);
    if (deg > -5.5) lightDir.copy(world.sunDir).setY(Math.max(world.sunDir.y, 0.03)).normalize();
    else if (world.moonDir.y > 0.02) lightDir.copy(world.moonDir);
    else lightDir.set(0.3, 0.8, 0.5).normalize();
    // the low sun is dimmer as well as warmer: more air in the way
    const airmass = sstep(deg, -2, 30);
    sun.intensity = DAY.sun * st.daylight * (0.35 + 0.65 * airmass) + NIGHT.sun * st.moonlight * (0.6 + 0.4 * moonUp);
    cloudNight.value.set(0.55, 0.68, 1.0).multiplyScalar(0.008 * st.dark * st.dark);
    sun.color.copy(DAY.sunColor).lerp(SUNSET, st.warmth * 0.85).lerp(NIGHT.sunColor, st.moonlight);
    // Around sunset the sun gives the ground almost nothing (grazing, through thick air) while the sky is still
    // bright: without more sky fill the ground is darker at dusk than at night.
    const lowSun = st.lowSun = (1 - sstep(deg, 2, 35)) * (1 - st.dark);
    st.exposure = lerp(DAY.exposure, NIGHT.exposure, Math.pow(st.dark, LOW.darkPow)) * (1 + LOW.lift * lowSun);
    // ... so the sky fill is raised to hold the floor (see GROUND_FLOOR); it lets go only in the last of twilight,
    // where it meets the night's own level from above. Terrain and buildings share these lights: both come up.
    const baseHemi = lerp(DAY.hemi, NIGHT.hemi, st.dark), flatSun = sun.intensity * Math.max(lightDir.y, 0);
    const need = GROUND_FLOOR / st.exposure - flatSun;
    hemi.intensity = Math.max(baseHemi, lerp(need, baseHemi, sstep(st.dark, 0.9, 1)));
    st.fill = hemi.intensity / baseHemi - 1;
    st.ground = (hemi.intensity + flatSun) * st.exposure;
    const duskFill = (1 - sstep(deg, 6, 20)) * (1 - st.dark);
    hemi.color.copy(HEMI_SKY).lerp(HEMI_DUSK, 0.7 * duskFill * sstep(deg, -5, 1));   // the fill of a low sun is the warm half of the sky
    grade.g.set(lerp(1.1, 1.0, st.dark), LOW.curve * (1 - st.dark) * (1 - 0.45 * duskFill), lerp(1.12 + LOW.sat * lowSun, 1.0, st.dark));
    grade.lift = LOW.shadows * duskFill;
    st.bloom = lerp(DAY.bloom, NIGHT.bloom, st.dark);
    bloom.intensity = st.bloom;

    // analytic sky colours (scene units) for the water's reflection, the environment map and the fallback sky
    const u = ocean.uniforms, dusk = st.warmth * (1 - sstep(deg, 8, 24) * 0.6), day = 0.25 + 0.75 * sstep(deg, -4, 20);
    (u.uZen.value as THREE.Vector3).copy(cDayZen).lerp(cDuskZen, dusk).multiplyScalar(day).lerp(cNightZen, st.dark);
    (u.uHor.value as THREE.Vector3).copy(cDayHor).lerp(cDuskHor, dusk * 0.8).multiplyScalar(day).lerp(cNightHor, st.dark);
    // civil and nautical twilight: the physical sky has little left, but the eye still sees a deep blue dome
    const tw = sstep(-deg, -2, 5) * (1 - sstep(-deg, 7, 15));
    (u.uZen.value as THREE.Vector3).x += 0.010 * tw; (u.uZen.value as THREE.Vector3).y += 0.022 * tw; (u.uZen.value as THREE.Vector3).z += 0.058 * tw;
    (u.uHor.value as THREE.Vector3).x += 0.022 * tw; (u.uHor.value as THREE.Vector3).y += 0.024 * tw; (u.uHor.value as THREE.Vector3).z += 0.042 * tw;
    tmpC.copy(sun.color).multiplyScalar(sun.intensity);
    (u.uGlow.value as THREE.Vector3).set(tmpC.r, tmpC.g, tmpC.b).multiplyScalar(0.22 * st.daylight);
    (u.uSunDir.value as THREE.Vector3).copy(world.sunDir);
    (u.uLightDir.value as THREE.Vector3).copy(lightDir);
    (u.uLightE.value as THREE.Vector3).set(tmpC.r, tmpC.g, tmpC.b);
    const zen = u.uZen.value as THREE.Vector3, hor = u.uHor.value as THREE.Vector3, k = Math.max(lightDir.y, 0) / Math.PI;
    (u.uEd.value as THREE.Vector3).set(tmpC.r * k + 0.5 * (zen.x + hor.x), tmpC.g * k + 0.5 * (zen.y + hor.y), tmpC.b * k + 0.5 * (zen.z + hor.z));
    // (the sea, its foam and the orbit cloud field get the raised sky fill too, or the land would outshine a black sea at dusk)
    const extra = 0.5 * (hemi.intensity - baseHemi) / Math.PI;
    (u.uEd.value as THREE.Vector3).x += extra * hemi.color.r; (u.uEd.value as THREE.Vector3).y += extra * hemi.color.g; (u.uEd.value as THREE.Vector3).z += extra * hemi.color.b;
    u.uNight.value = st.dark;
    if (bakedSun.angleTo(world.sunDir) > 0.035) bakeEnv();
  }

  let orbitOnly = false;   // from orbit the volumetric clouds are replaced by the ocean pass's 2D cloud field
  function applyMode(next: Mode): void {
    mode = next;
    const tk = next === 'takram';
    const q = S.quality.value;
    const cloudsOn = tk && !!cloudPass && q !== 'low' && S.layerOn.value.clouds !== false && !orbitOnly && !st.observed;
    scaleInPass.enabled = tk;
    if (cloudPass) cloudPass.enabled = cloudsOn;
    if (skyPass) skyPass.enabled = tk && !cloudsOn;
    ocean.uniforms.uBasic.value = tk ? 0 : 1;
  }
  applyMode('basic');

  let lastQuality = '', lastCover = -1;
  const oin = { seaLevel: 0, time: 0, windMs: 6, windDirDeg: 80, waveH: 1.2, wavePeriod: 8, waveDirDeg: 60 };   // reused: nothing allocates per frame
  function render(frame: Frame): void {
    if (mode === 'plain') { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
    if (shaderFailed) {
      shaderFailed = false;
      if (!oceanFailed && wantTakram) { wantTakram = false; warn('shader compile error'); applyMode('basic'); }
      else { mode = 'plain'; scene.background = new THREE.Color(0x7fa8cf); console.warn('[garita/post] ocean pass failed too: plain render'); return; }
    }
    const want: Mode = wantTakram && lutsReady ? 'takram' : 'basic';
    const q = S.quality.value, cover = S.weather.value.cloudCover;
    // Observed rain or cloud is on the map (radar, GOES): our procedural clouds, their shading of the ground and the
    // 2D field from orbit are switched off, so that nothing of ours can be read as part of the observation.
    const ov = S.overlay.value, observed = ov === 'radar' || ov === 'goes' || ov === 'nightlights';
    if (want !== mode || q !== lastQuality || observed !== st.observed) {
      st.observed = observed;
      lastQuality = q;
      if (clouds) clouds.qualityPreset = q === 'high' ? 'high' : 'medium';
      bloom.blendMode.opacity.value = q === 'low' ? 0.6 : 1;
      applyMode(want);
    }

    const tgt = world.controls?.target ?? sun.target.position, range = camera.position.distanceTo(tgt);
    // ---- sun (or moon) shadows near the ground: an orthographic map centred on the target, snapped to its texels
    const wantShadow = q !== 'low' && !off('shadows') && range < 8000 && (st.elevation > 4 || (st.elevation < -5.5 && world.moonDir.y > 0.15));
    if (wantShadow !== sun.castShadow) { sun.castShadow = wantShadow; st.shadows = wantShadow; }
    if (wantShadow) {
      const size = q === 'high' ? 4096 : 2048;
      if (sun.shadow.mapSize.x !== size) { sun.shadow.mapSize.set(size, size); sun.shadow.map?.dispose(); (sun.shadow as any).map = null; }
      const ext = 150 * Math.pow(1.3, Math.ceil(Math.log(THREE.MathUtils.clamp(range * 0.75, 150, 3000) / 150) / Math.log(1.3)));   // half-width, in coarse steps
      const dist = ext * 2.5 + 600, sc = sun.shadow.camera;
      if (ext !== st.shadowExtent) {
        st.shadowExtent = ext;
        sc.left = sc.bottom = -ext; sc.right = sc.top = ext; sc.near = 5; sc.far = dist * 2; sc.updateProjectionMatrix();
        sun.shadow.normalBias = 0.25 + ext / 900;
      }
      const texel = (2 * ext) / size;
      sRight.crossVectors(Y_UP, lightDir); if (sRight.lengthSq() < 1e-8) sRight.set(1, 0, 0); sRight.normalize();
      sUp.crossVectors(lightDir, sRight);
      const rx = tgt.dot(sRight), ry = tgt.dot(sUp);
      sun.target.position.copy(tgt).addScaledVector(sRight, Math.round(rx / texel) * texel - rx).addScaledVector(sUp, Math.round(ry / texel) * texel - ry);
      sun.position.copy(sun.target.position).addScaledVector(lightDir, dist);
    } else {
      sun.target.position.copy(tgt);
      sun.position.copy(tgt).addScaledVector(lightDir, 1e5);
    }
    const expo = st.exposure * (1 + LOW.orbit * st.lowSun * sstep(ocean.uniforms.uCamH.value, 30000, 150000));
    scaleOut.k = mode === 'takram' ? expo / UNITS : expo;
    const w = S.weather.value;
    oin.seaLevel = world.seaLevel; oin.time = frame.now; oin.windMs = w.windMs; oin.windDirDeg = w.windDirDeg;
    oin.waveH = w.waveHeightM; oin.wavePeriod = w.wavePeriodS; oin.waveDirDeg = w.waveDirDeg;
    ocean.update(oin);
    ocean.uniforms.uRise.value = S.scenario.value.seaLevelM;   // (the scenario's rise alone, without the tide: marks flooded land)
    // Volumetric clouds up to ~60 km camera height; from there to 150 km they give way to the 2D field (specks otherwise).
    const cloudsWanted = wantClouds && q !== 'low' && S.layerOn.value.clouds !== false && !observed;
    const orbit = cloudsWanted ? sstep(ocean.uniforms.uCamH.value, 60000, 150000) : 0;
    ocean.uniforms.uOrbit.value = orbit;
    (ocean.uniforms.uCloud2.value as THREE.Vector4).w = (cover - 0.3) * 0.25;
    const cov = THREE.MathUtils.clamp(0.2 + 0.22 * cover, 0, 0.42) * (1 - orbit);   // (above ~0.4 the layer closes into a flat deck)
    if (clouds && cov !== lastCover) { lastCover = cov; clouds.coverage = cov; }
    if ((orbit > 0.999) !== orbitOnly) { orbitOnly = orbit > 0.999; applyMode(mode); }
    try { composer.render(frame.dt); }
    catch (e) { if (mode === 'takram') { wantTakram = false; warn(e); applyMode('basic'); } else { mode = 'plain'; console.warn('[garita/post] render failed: plain render', e); } }
  }

  setTime(S.sceneTime.value);
  bakeEnv();

  const api = {
    render,
    resize(width: number, height: number, dpr: number) { renderer.setPixelRatio(dpr); composer.setSize(width, height, false); },
    setTime,
    setSeaLevel(m: number) { world.seaLevel = m; },
    dispose() {
      renderer.debug.onShaderError = prevOnShaderError;
      scene.remove(sun, sun.target, hemi);
      scene.environment = null; envRT?.dispose(); pmrem.dispose();
      composer.dispose();
    },
    // not part of PostApi: for the test page
    overWaterLayer: OVER_WATER_LAYER,
    set overWater(v: boolean) { ocean.overWater = v; },
    get overWater() { return ocean.overWater; },
    tune: { DAY, NIGHT, LOW, sun, hemi, clouds: () => clouds, aerial: () => aerial, ocean, grade, bloom, cloudGain, field, apply: () => setTime(date.getTime()) },
    ...({ debug: () => ({ mode, lutsReady, clouds: !!cloudPass?.enabled, units: UNITS, ...st, sun: world.sunDir.toArray().map((v) => +v.toFixed(3)) }) } as object),
  };
  return api as PostApi;
}
