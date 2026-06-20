import '../style.css';

import * as THREE from 'three';
import { scene, cameras } from './scene';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Car } from './car';
import { createTrack } from './track';

let renderer: THREE.WebGLRenderer;
let car: Car;
let curve: any;
let controls: OrbitControls;
let viewerBody: HTMLElement;

export async function setupRender () {
viewerBody = document.querySelector('.viewer-body') as HTMLElement;

const canvas = document.createElement('canvas');
viewerBody.innerHTML = ''; 
viewerBody.appendChild(canvas);

renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

const width = viewerBody.clientWidth;
const height = viewerBody.clientHeight;
renderer.setSize(width, height);

controls = new OrbitControls(cameras.front, renderer.domElement);

const points = Array.from({ length: 10 }, () => 
    new THREE.Vector3((Math.random() - 0.5) * 30, 0, (Math.random() - 0.5) * 30)
);

const track = createTrack(points);
curve = track.curve;
scene.add(track.trackGroup);

car = new Car();
await car.load('/car_model/scene.gltf');
scene.add(car.mesh);
}

// Функція для малювання у конкретному вікні (viewport)
function renderView(camera: THREE.PerspectiveCamera, left: number, bottom: number, width: number, height: number) {
    renderer.setViewport(left, bottom, width, height);
    renderer.setScissor(left, bottom, width, height);
    renderer.setScissorTest(true);
    
    // Очищаємо буфер перед малюванням кожного вікна
    renderer.clear(); 
    
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    
    renderer.render(scene, camera); 
}

export function runRender(t: number) {

    //!!!!!!!!!!!!!!!!!!!!!! поміняти щоб підключити фізику !!!!!!!!!!!!!!!!!!!!!!!
    const position = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    car.update(position, tangent);
    //!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

    controls.update();

    const w = viewerBody.clientWidth / 3;
    const h = viewerBody.clientHeight;

    // 1. Front
    renderView(cameras.front, 0, 0, w, h);
    // 2. Top
    renderView(cameras.top, w * 2, 0, w, h);
    // 3. Inside
    const offset = new THREE.Vector3(0, 1.5, 0);
    offset.applyQuaternion(car.mesh.quaternion); //прив'язуємо до повороту машини
    const cameraPosition = car.mesh.position.clone().add(offset); // трохки піднімаємо основу камеру
    cameras.inside.position.lerp(cameraPosition, 0.1);
    cameras.inside.lookAt(car.mesh.position.clone().add(tangent.clone().multiplyScalar(5))); // спрямовуємо вперед
    
    renderView(cameras.inside, w, 0, w, h);
}