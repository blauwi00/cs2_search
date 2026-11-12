// 3D-кейс Dreams & Nightmares (стилизованный, собран из простых форм): корпус, крышка на петлях с рёбрами, застёжки, ручки,
// наклейка с ромбом CS:GO и щупальцем на лицевой грани, свет и искры внутри. Подключается как <script type="module">.
// Управление — через window.__case3d.setup(tl, { w, h, t: {...моменты в секундах} }): все движения добавляются в таймлайн gsap.
import * as THREE from './three.module.js';
import { RoundedBoxGeometry } from './RoundedBoxGeometry.js';

const W = 1080, H = 1500;
const canvas = document.getElementById('c3');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(W, H, false); renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 100); cam.position.set(0, 4.4, 10.8); cam.lookAt(0, 0.9, 0);
let LOOK_Y = 0.9;

// ---- свет ----
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8aa0, 2.3));
const key = new THREE.DirectionalLight(0xffffff, 0.55); key.position.set(3.5, 5.5, 4.5); scene.add(key);
const rim = new THREE.DirectionalLight(0x9db4ff, 0.25); rim.position.set(-4, 2.5, -3); scene.add(rim);
const inner = new THREE.PointLight(0xffc85a, 0, 7); inner.position.set(0, 0.7, 0); scene.add(inner);

// ---- модель: коробка, обтянутая фотографией референса (развёртки граней получены перспективным выпрямлением снимка) ----
const TL = new THREE.TextureLoader();
const tex = (n) => { const t = TL.load(new URL('./tex/' + n + '.png', import.meta.url).href, () => { try { render(); } catch (e) { /* сцена ещё не готова */ } }); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
const mat = (n) => new THREE.MeshStandardMaterial({ map: tex(n), metalness: 0.0, roughness: 0.62 });
const dark = new THREE.MeshStandardMaterial({ color: 0x2a2630, roughness: 0.8 });
const innerMat = new THREE.MeshStandardMaterial({ color: 0x1b1722, metalness: 0.2, roughness: 0.8 });

const BW = 2.7, D = 1.9, HB = 1.33, HL = 0.3; // длина, глубина, корпус, крышка
const root = new THREE.Group(); scene.add(root);
// порядок граней BoxGeometry: +x, -x, +y, -y, +z, -z
const body = new THREE.Mesh(new RoundedBoxGeometry(BW, HB, D, 3, 0.035), [mat('side_body'), mat('side_body_m'), dark, dark, mat('front_body'), mat('front_body_m')]);
body.position.y = HB / 2; root.add(body);
// нутро
const tray = new THREE.Mesh(new THREE.BoxGeometry(BW - 0.2, 0.04, D - 0.2), innerMat); tray.position.y = HB - 0.02; root.add(tray);
const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(BW - 0.3, D - 0.3), new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
glowPlane.rotation.x = -Math.PI / 2; glowPlane.position.y = HB + 0.01; root.add(glowPlane);
const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 0.9, 3.4, 40, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
beam.position.y = HB + 1.7; root.add(beam); beam.visible = false;
const gc = document.createElement('canvas'); gc.width = gc.height = 256; { const g2 = gc.getContext('2d'); const rg2 = g2.createRadialGradient(128, 128, 0, 128, 128, 128); rg2.addColorStop(0, 'rgba(255,225,140,1)'); rg2.addColorStop(.35, 'rgba(255,190,70,.55)'); rg2.addColorStop(1, 'rgba(255,170,40,0)'); g2.fillStyle = rg2; g2.fillRect(0, 0, 256, 256); }
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(gc), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })); halo.scale.set(6.2, 6.2, 1); halo.position.set(0, HB + 0.9, 0.3); root.add(halo);
const NS = 70, sp = new Float32Array(NS * 3), sv = [];
for (let i = 0; i < NS; i++) { sp[i * 3] = (Math.random() - .5) * 2.2; sp[i * 3 + 1] = HB; sp[i * 3 + 2] = (Math.random() - .5) * 1.4; sv.push({ s: 0.8 + Math.random() * 1.8, d: Math.random() }); }
const spGeo = new THREE.BufferGeometry(); spGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
const sparks = new THREE.Points(spGeo, new THREE.PointsMaterial({ color: 0xffe9a8, size: 0.07, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })); root.add(sparks);
// крышка на петле (по задней верхней кромке)
const hinge = new THREE.Group(); hinge.position.set(0, HB, -D / 2); root.add(hinge);
const lid = new THREE.Mesh(new RoundedBoxGeometry(BW + 0.01, HL, D + 0.01, 3, 0.035), [mat('side_lid'), mat('side_lid_m'), mat('top'), dark, mat('front_lid'), mat('front_lid_m')]);
lid.position.set(0, HL / 2, D / 2); hinge.add(lid);
root.position.y = -0.55; root.rotation.set(0.0, -0.62, 0);
function render() { renderer.render(scene, cam); }

window.__case3d = {
  /** t: { fly, openAt, slamAt, end } — моменты в секундах; tl — общий таймлайн gsap. */
  setup(tl, t) {
    if (t.lookY != null) { LOOK_Y = t.lookY; cam.lookAt(0, LOOK_Y, 0); }
    const st = { glow: 0, spark: 0, shake: 0 };
    root.visible = false;
    tl.set(root, { visible: true }, t.fly);
    tl.fromTo(root.position, { y: 4.2 }, { y: -0.55, duration: 1.0, ease: 'bounce.out' }, t.fly);
    tl.fromTo(root.scale, { x: 0.45, y: 0.45, z: 0.45 }, { x: 1, y: 1, z: 1, duration: 0.8, ease: 'back.out(1.5)' }, t.fly);
    tl.fromTo(root.rotation, { y: -0.62 }, { y: -0.62 + Math.PI * 4, duration: 1.7, ease: 'power3.out' }, t.fly);
    tl.to(root.rotation, { y: -0.62 + Math.PI * 4 + 0.5, duration: 1.2, ease: 'sine.inOut', yoyo: true, repeat: 1 }, t.fly + 1.9);
    // крышка поднимается, внутри свет
    tl.to(root.rotation, { x: 0.1, y: -0.62 + Math.PI * 4 - 0.15, duration: 0.5, ease: 'power2.out' }, t.openAt - 0.05);
    tl.to(hinge.rotation, { x: -1.2, duration: 0.6, ease: 'back.out(1.7)' }, t.openAt);
    tl.to(st, { glow: 1, duration: 0.6, ease: 'power2.out' }, t.openAt);
    tl.to(st, { spark: 1, duration: Math.max(0.5, t.slamAt - t.openAt - 0.25), ease: 'none' }, t.openAt + 0.2);
    const pulses = Math.max(1, Math.floor((t.slamAt - t.openAt - 0.8) / 0.45));
    tl.to(st, { glow: 0.55, duration: 0.45, ease: 'sine.inOut', yoyo: true, repeat: pulses - 1 }, t.openAt + 0.7);
    // резкий хлопок: крышка падает, сжатие, тряска, свет гаснет
    tl.to(hinge.rotation, { x: 0, duration: 0.07, ease: 'power4.in' }, t.slamAt);
    tl.set(st, { glow: 0, spark: 0 }, t.slamAt + 0.06);
    tl.to(root.scale, { y: 0.86, x: 1.06, z: 1.06, duration: 0.06, ease: 'power2.in' }, t.slamAt + 0.05);
    tl.to(root.scale, { y: 1, x: 1, z: 1, duration: 0.4, ease: 'elastic.out(1.2,0.4)' }, t.slamAt + 0.11);
    tl.to(root.rotation, { x: 0.0, duration: 0.3, ease: 'power2.out' }, t.slamAt + 0.05);
    tl.fromTo(st, { shake: 1 }, { shake: 0, duration: 0.5, ease: 'power2.out', immediateRender: false }, t.slamAt + 0.06);
    tl.eventCallback('onUpdate', () => {
      inner.intensity = st.glow * 9; glowPlane.material.opacity = st.glow * 0.85; halo.material.opacity = st.glow * 0.85; sparks.material.opacity = st.glow > 0.01 ? 0.95 : 0;
      for (let i = 0; i < NS; i++) { const p = (st.spark * sv[i].s + sv[i].d) % 1; sp[i * 3 + 1] = HB + p * 3.2; }
      spGeo.attributes.position.needsUpdate = true;
      cam.position.x = Math.sin(st.shake * 40) * 0.12 * st.shake; cam.position.y = 4.4 + Math.cos(st.shake * 33) * 0.06 * st.shake; cam.lookAt(0, LOOK_Y, 0);
      render();
    });
    render();
  },
};
