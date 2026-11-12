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
const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 100); cam.position.set(0, 2.0, 10.8); cam.lookAt(0, 1.2, 0);

// ---- свет ----
scene.add(new THREE.HemisphereLight(0xfff0e6, 0x2a3350, 1.05));
const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(3.5, 5.5, 4.5); scene.add(key);
const rim = new THREE.DirectionalLight(0x9db4ff, 1.1); rim.position.set(-4, 2.5, -3); scene.add(rim);
const inner = new THREE.PointLight(0xffc85a, 0, 7); inner.position.set(0, 0.7, 0); scene.add(inner);

// ---- материалы ----
const grad = (c0, c1, c2) => { const c = document.createElement('canvas'); c.width = 8; c.height = 256; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, c0); gr.addColorStop(.45, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, 8, 256); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
const bodyMat = new THREE.MeshStandardMaterial({ map: grad('#d99682', '#a98a95', '#6c7391'), metalness: 0.42, roughness: 0.46 });
const lidMat = new THREE.MeshStandardMaterial({ map: grad('#e2a08a', '#cf9684', '#b88492'), metalness: 0.45, roughness: 0.42 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x15171d, metalness: 0.6, roughness: 0.5 });
const metalMat = new THREE.MeshStandardMaterial({ color: 0xb9b3b8, metalness: 0.85, roughness: 0.32 });
const innerMat = new THREE.MeshStandardMaterial({ color: 0x1b1722, metalness: 0.2, roughness: 0.8 });

const BW = 2.7, BH = 1.0, BD = 1.78, LH = 0.62; // корпус и крышка
const root = new THREE.Group(); scene.add(root);
const body = new THREE.Mesh(new RoundedBoxGeometry(BW, BH, BD, 5, 0.07), bodyMat); body.position.y = BH / 2; root.add(body);
// ребро-рамка по низу и вертикальные рёбра на углах
const base = new THREE.Mesh(new RoundedBoxGeometry(BW + 0.06, 0.12, BD + 0.06, 3, 0.04), metalMat); base.position.y = 0.06; root.add(base);
for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const r = new THREE.Mesh(new RoundedBoxGeometry(0.1, BH, 0.1, 3, 0.03), metalMat); r.position.set(sx * (BW / 2 - 0.02), BH / 2, sz * (BD / 2 - 0.02)); root.add(r); }
// вертикальные рёбра на лицевой и задней стенке
for (const sz of [-1, 1]) for (const x of [-0.95, 0.95]) { const r = new THREE.Mesh(new RoundedBoxGeometry(0.1, BH - 0.05, 0.05, 2, 0.02), metalMat); r.position.set(x, BH / 2, sz * (BD / 2 + 0.01)); root.add(r); }
// ручки на торцах
for (const sx of [-1, 1]) { const h = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.42, 0.78, 3, 0.03), darkMat); h.position.set(sx * (BW / 2 + 0.03), BH * 0.52, 0); root.add(h); const hi = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.26, 0.56, 3, 0.03), innerMat); hi.position.set(sx * (BW / 2 + 0.035), BH * 0.52, 0); root.add(hi); }
// нутро: тёмный лоток и светящаяся плоскость
const tray = new THREE.Mesh(new THREE.BoxGeometry(BW - 0.22, 0.04, BD - 0.22), innerMat); tray.position.y = BH - 0.02; root.add(tray);
const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(BW - 0.3, BD - 0.3), new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
glowPlane.rotation.x = -Math.PI / 2; glowPlane.position.y = BH + 0.01; root.add(glowPlane);
// луч света
const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 0.9, 3.4, 40, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
beam.position.y = BH + 1.7; root.add(beam);
// искры
const NS = 70, sp = new Float32Array(NS * 3), sv = [];
for (let i = 0; i < NS; i++) { sp[i * 3] = (Math.random() - .5) * 2.2; sp[i * 3 + 1] = BH; sp[i * 3 + 2] = (Math.random() - .5) * 1.3; sv.push({ s: 0.8 + Math.random() * 1.8, d: Math.random() }); }
const spGeo = new THREE.BufferGeometry(); spGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
const sparks = new THREE.Points(spGeo, new THREE.PointsMaterial({ color: 0xffe9a8, size: 0.07, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })); root.add(sparks);

// крышка на петле (шарнир по задней верхней кромке)
const hinge = new THREE.Group(); hinge.position.set(0, BH, -BD / 2); root.add(hinge);
const lid = new THREE.Mesh(new RoundedBoxGeometry(BW + 0.02, LH, BD + 0.02, 5, 0.09), lidMat); lid.position.set(0, LH / 2 - 0.02, BD / 2); hinge.add(lid);
for (const z of [-0.5, 0, 0.5]) { const rib = new THREE.Mesh(new RoundedBoxGeometry(BW - 0.35, 0.06, 0.13, 3, 0.025), lidMat); rib.position.set(0, LH - 0.0, BD / 2 + z); hinge.add(rib); }
const lidEdge = new THREE.Mesh(new RoundedBoxGeometry(BW + 0.07, 0.1, BD + 0.07, 3, 0.04), metalMat); lidEdge.position.set(0, 0.02, BD / 2); hinge.add(lidEdge);
// застёжки спереди
for (const x of [-0.98, 0.98]) { const clasp = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.5, 0.06, 3, 0.02), metalMat); clasp.position.set(x, -0.02, BD + 0.02); hinge.add(clasp); }
const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 10, 24), metalMat); ring.position.set(0.98, -0.2, BD + 0.07); hinge.add(ring);
for (const sx of [-1, 1]) { const h = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.3, 0.7, 3, 0.03), darkMat); h.position.set(sx * (BW / 2 + 0.04), 0.1, BD / 2); hinge.add(h); }

// наклейка спереди: ромб CS:GO, облачко и щупальце
const lc = document.createElement('canvas'); lc.width = 1024; lc.height = 512; const g = lc.getContext('2d');
g.clearRect(0, 0, 1024, 512);
g.save(); g.translate(380, 250); g.rotate(Math.PI / 4);
const rg = g.createLinearGradient(-150, -150, 150, 150); rg.addColorStop(0, '#f3e6ee'); rg.addColorStop(1, '#8b7fb0'); g.fillStyle = rg; g.beginPath(); g.roundRect(-150, -150, 300, 300, 34); g.fill();
g.lineWidth = 12; g.strokeStyle = '#2a2638'; g.stroke(); g.restore();
g.strokeStyle = '#2a2638'; g.lineWidth = 14; g.lineCap = 'round'; g.beginPath(); g.arc(380, 190, 38, 0.5, 5.6); g.moveTo(380, 190); g.bezierCurveTo(410, 150, 440, 180, 420, 215); g.stroke();
g.fillStyle = '#2a2638'; g.font = '900 86px Montserrat, Arial Black, sans-serif'; g.textAlign = 'center'; g.fillText('CS:GO', 380, 345);
g.strokeStyle = 'rgba(38,32,54,.82)'; g.lineWidth = 26; g.beginPath(); g.moveTo(760, 470); g.bezierCurveTo(820, 420, 700, 360, 790, 310); g.bezierCurveTo(870, 260, 800, 200, 880, 170); g.stroke();
g.fillStyle = 'rgba(38,32,54,.7)'; for (const [x, y] of [[775, 440], [760, 395], [785, 340], [820, 290], [850, 240]]) { g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); }
const labelTex = new THREE.CanvasTexture(lc); labelTex.colorSpace = THREE.SRGBColorSpace; labelTex.anisotropy = 4;
const label = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.0), new THREE.MeshStandardMaterial({ map: labelTex, transparent: true, metalness: 0.2, roughness: 0.6 }));
label.position.set(0, BH * 0.46, BD / 2 + 0.012); root.add(label);

root.position.y = -0.55; root.rotation.set(0.08, -0.5, 0);
function render() { renderer.render(scene, cam); }

window.__case3d = {
  /** t: { fly, openAt, slamAt, end } — моменты в секундах; tl — общий таймлайн gsap. */
  setup(tl, t) {
    const st = { glow: 0, spark: 0, shake: 0 };
    root.visible = false;
    tl.set(root, { visible: true }, t.fly);
    tl.fromTo(root.position, { y: 4.2 }, { y: -0.55, duration: 1.0, ease: 'bounce.out' }, t.fly);
    tl.fromTo(root.scale, { x: 0.45, y: 0.45, z: 0.45 }, { x: 1, y: 1, z: 1, duration: 0.8, ease: 'back.out(1.5)' }, t.fly);
    tl.fromTo(root.rotation, { y: -0.5 }, { y: -0.5 + Math.PI * 4, duration: 1.7, ease: 'power3.out' }, t.fly);
    tl.to(root.rotation, { y: -0.5 + Math.PI * 4 + 0.5, duration: 1.2, ease: 'sine.inOut', yoyo: true, repeat: 1 }, t.fly + 1.9);
    // крышка поднимается, внутри свет
    tl.to(root.rotation, { x: 0.22, y: -0.5 + Math.PI * 4 + 0.15, duration: 0.5, ease: 'power2.out' }, t.openAt - 0.05);
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
    tl.to(root.rotation, { x: 0.08, duration: 0.3, ease: 'power2.out' }, t.slamAt + 0.05);
    tl.fromTo(st, { shake: 1 }, { shake: 0, duration: 0.5, ease: 'power2.out', immediateRender: false }, t.slamAt + 0.06);
    tl.eventCallback('onUpdate', () => {
      inner.intensity = st.glow * 9; glowPlane.material.opacity = st.glow * 0.85; beam.material.opacity = st.glow * 0.12; sparks.material.opacity = st.glow > 0.01 ? 0.95 : 0;
      for (let i = 0; i < NS; i++) { const p = (st.spark * sv[i].s + sv[i].d) % 1; sp[i * 3 + 1] = BH + p * 3.2; }
      spGeo.attributes.position.needsUpdate = true;
      cam.position.x = Math.sin(st.shake * 40) * 0.12 * st.shake; cam.position.y = 2.0 + Math.cos(st.shake * 33) * 0.06 * st.shake; cam.lookAt(0, 1.2, 0);
      render();
    });
    render();
  },
};
