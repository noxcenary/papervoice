import * as React from 'react';
import * as THREE from 'three';
import { GUI } from 'dat.gui';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { IconMicrophone, IconPlayerStopFilled, IconAdjustmentsHorizontal } from '@tabler/icons-react';

// Ashima 3D Periodic Perlin noise vertex shader
const vertexShader = `
uniform float u_time;
uniform float u_frequency;

vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
  return mod289(((x * 34.0) + 10.0) * x);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec3 fade(vec3 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Classic Perlin noise, periodic variant
float pnoise(vec3 P, vec3 rep) {
  vec3 Pi0 = mod(floor(P), rep);
  vec3 Pi1 = mod(Pi0 + vec3(1.0), rep);
  Pi0 = mod289(Pi0);
  Pi1 = mod289(Pi1);
  vec3 Pf0 = fract(P);
  vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;

  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);

  vec4 gx0 = ixy0 * (1.0 / 7.0);
  vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);

  vec4 gx1 = ixy1 * (1.0 / 7.0);
  vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);

  vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
  vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
  vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
  vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
  vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
  vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
  vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
  vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);

  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;

  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);

  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x); 
  return 2.2 * n_xyz;
}

void main() {
  float noise = 3.0 * pnoise(position + u_time, vec3(10.0));
  float displacement = (u_frequency / 30.0) * (noise / 10.0);
  vec3 newPosition = position + normal * displacement;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
}
`;

// RGB Fragment Shader
const fragmentShader = `
uniform float u_red;
uniform float u_blue;
uniform float u_green;

void main() {
  gl_FragColor = vec4(vec3(u_red, u_green, u_blue), 1.0);
}
`;

export function VoiceAuroraWave({
  size = 350,
  level,
  isListeningControlled = false,
  onToggle,
  label,
  audioRef,
}) {
  const mountRef = React.useRef(null);
  const guiContainerRef = React.useRef(null);
  const uniformsRef = React.useRef(null);
  const analyserRef = React.useRef(null);
  const soundRef = React.useRef(null);
  const listenerRef = React.useRef(null);
  const [guiOpen, setGuiOpen] = React.useState(false);

  React.useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || size;
    const height = container.clientHeight || size;

    // Renderer matching dark canvas
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a0c, 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Scene & Perspective Camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, -2, 14);
    camera.lookAt(0, 0, 0);

    // Visualizer Parameters
    const params = {
      red: 1.0,
      green: 1.0,
      blue: 1.0,
      threshold: 0.5,
      strength: 0.5,
      radius: 0.8,
    };

    // Uniforms
    const uniforms = {
      u_time: { type: 'f', value: 0.0 },
      u_frequency: { type: 'f', value: 0.0 },
      u_red: { type: 'f', value: params.red },
      u_green: { type: 'f', value: params.green },
      u_blue: { type: 'f', value: params.blue },
    };
    uniformsRef.current = uniforms;

    // Shader Material & Wireframe Icosahedron Geometry
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      wireframe: true,
    });

    const geo = new THREE.IcosahedronGeometry(4, 24);
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // Post-processing Bloom Chain
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      params.strength,
      params.radius,
      params.threshold
    );

    const bloomComposer = new EffectComposer(renderer);
    bloomComposer.addPass(renderScene);
    bloomComposer.addPass(bloomPass);

    const outputPass = new OutputPass();
    bloomComposer.addPass(outputPass);

    // Audio Listener & Analyser
    const listener = new THREE.AudioListener();
    camera.add(listener);
    listenerRef.current = listener;

    const sound = new THREE.Audio(listener);
    soundRef.current = sound;

    if (audioRef?.current) {
      try {
        sound.setMediaElementSource(audioRef.current);
        const analyser = new THREE.AudioAnalyser(sound, 32);
        analyserRef.current = analyser;
      } catch (err) {
        console.warn('THREE.AudioAnalyser setup:', err);
      }
    }

    // dat.gui Controller
    const gui = new GUI({ autoPlace: false, width: 230 });
    const colorsFolder = gui.addFolder('Colors');
    colorsFolder.add(params, 'red', 0, 1, 0.01).onChange((value) => {
      uniforms.u_red.value = Number(value);
    });
    colorsFolder.add(params, 'green', 0, 1, 0.01).onChange((value) => {
      uniforms.u_green.value = Number(value);
    });
    colorsFolder.add(params, 'blue', 0, 1, 0.01).onChange((value) => {
      uniforms.u_blue.value = Number(value);
    });
    colorsFolder.open();

    const bloomFolder = gui.addFolder('Bloom');
    bloomFolder.add(params, 'threshold', 0, 1, 0.01).onChange((value) => {
      bloomPass.threshold = Number(value);
    });
    bloomFolder.add(params, 'strength', 0, 3, 0.05).onChange((value) => {
      bloomPass.strength = Number(value);
    });
    bloomFolder.add(params, 'radius', 0, 1, 0.01).onChange((value) => {
      bloomPass.radius = Number(value);
    });
    bloomFolder.open();

    if (guiContainerRef.current) {
      guiContainerRef.current.appendChild(gui.domElement);
    }

    // Mouse Tracking (matching user formula)
    let mouseX = 0;
    let mouseY = 0;
    const handleMouseMove = (e) => {
      const windowHalfX = window.innerWidth / 2;
      const windowHalfY = window.innerHeight / 2;
      mouseX = (e.clientX - windowHalfX) / 100;
      mouseY = (e.clientY - windowHalfY) / 100;
    };
    window.addEventListener('mousemove', handleMouseMove);

    // Resize Handler
    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || size;
      const h = container.clientHeight || size;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      bloomComposer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    // Animation Loop
    const clock = new THREE.Clock();
    let animId = 0;

    const animate = () => {
      animId = requestAnimationFrame(animate);

      // Camera lerp
      camera.position.x += (mouseX - camera.position.x) * 0.05;
      camera.position.y += (-mouseY - camera.position.y) * 0.05;
      camera.lookAt(scene.position);

      const elapsedTime = clock.getElapsedTime();
      uniforms.u_time.value = elapsedTime;

      // Rotate wireframe sphere continuously
      mesh.rotation.y = elapsedTime * 0.15;
      mesh.rotation.x = elapsedTime * 0.08;

      // Audio Frequency
      if (analyserRef.current) {
        uniforms.u_frequency.value = analyserRef.current.getAverageFrequency();
      }

      bloomComposer.render();
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('mousemove', handleMouseMove);
      resizeObserver.disconnect();

      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }

      try {
        gui.destroy();
      } catch {
        // no-op
      }

      geo.dispose();
      mat.dispose();
      renderer.dispose();
      bloomComposer.dispose();
    };
  }, [size, audioRef]);

  // Fallback / external level support
  React.useEffect(() => {
    if (typeof level === 'number' && uniformsRef.current && !analyserRef.current) {
      uniformsRef.current.u_frequency.value = level * 100.0;
    }
  }, [level]);

  // Resume AudioContext on playback interaction
  React.useEffect(() => {
    const audio = audioRef?.current;
    if (!audio) return;

    const resumeContext = () => {
      if (listenerRef.current?.context?.state === 'suspended') {
        listenerRef.current.context.resume();
      }
    };

    audio.addEventListener('play', resumeContext);
    return () => {
      audio.removeEventListener('play', resumeContext);
    };
  }, [audioRef]);

  return (
    <div className="three-aurora-wrapper relative w-full h-[360px] flex flex-col items-center justify-center select-none overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0c]">
      {/* Three.js canvas container */}
      <div
        ref={mountRef}
        className="three-canvas-container absolute inset-0 cursor-pointer"
        onClick={onToggle}
      />

      {/* Floating dat.gui container with toggle button */}
      <div className="absolute top-3 right-3 z-50 flex flex-col items-end">
        <button
          type="button"
          onClick={() => setGuiOpen(!guiOpen)}
          className="fx-toggle-btn flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-white/20 bg-black/80 text-white/90 hover:text-white hover:bg-black backdrop-blur transition-all pointer-events-auto"
          title="Toggle Visualizer GUI"
        >
          <IconAdjustmentsHorizontal size={14} />
          <span>FX GUI</span>
        </button>
        <div
          ref={guiContainerRef}
          style={{ display: guiOpen ? 'block' : 'none' }}
          className="three-dat-gui-box mt-2 pointer-events-auto"
        />
      </div>

      {/* Center play / pause action trigger button */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={isListeningControlled ? 'Pause audio' : 'Play audio'}
        className="voice-aurora-btn relative z-10 grid place-items-center rounded-full pointer-events-auto"
        style={{ width: 56, height: 56 }}
      >
        {isListeningControlled ? (
          <IconPlayerStopFilled size={22} />
        ) : (
          <IconMicrophone size={22} stroke={1.8} />
        )}
      </button>

      {/* Status label underneath */}
      {label && (
        <div className="voice-aurora-label relative z-10 mt-3 text-center text-[12.5px] pointer-events-none">
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}

export default VoiceAuroraWave;
