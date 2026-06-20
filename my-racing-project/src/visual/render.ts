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
return { track, car };
}

export const cameraKeys = ['orbit', 'cockpit', 'map'] as const;
export type CameraKey = typeof cameraKeys[number];
export let activeCameraKey: CameraKey = 'orbit';

export function cycleCamera() {
    const currentIndex = cameraKeys.indexOf(activeCameraKey);
    activeCameraKey = cameraKeys[(currentIndex + 1) % cameraKeys.length];
    console.log(`[CAMERA SWITCH] Switched to: ${activeCameraKey}`);
}

export function setRenderCurve(newCurve: any) {
    curve = newCurve;
}

export function runRender(t: number) {
    const position = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    car.update(position, tangent);

    // Update inside/cockpit camera position
    const offset = new THREE.Vector3(0, 0.45, 0);
    offset.applyQuaternion(car.mesh.quaternion);
    const cameraPosition = car.mesh.position.clone().add(offset);
    cameras.inside.position.lerp(cameraPosition, 0.1);
    cameras.inside.lookAt(car.mesh.position.clone().add(tangent.clone().multiplyScalar(1.5)));

    // Choose the active camera
    let activeCamera: THREE.PerspectiveCamera;
    if (activeCameraKey === 'orbit') {
        activeCamera = cameras.front;
        controls.enabled = true;
        const delta = car.mesh.position.clone().sub(controls.target);
        cameras.front.position.add(delta);
        controls.target.copy(car.mesh.position);
        controls.update();
    } else if (activeCameraKey === 'cockpit') {
        activeCamera = cameras.inside;
        controls.enabled = false;
    } else {
        activeCamera = cameras.top;
        cameras.top.position.set(car.mesh.position.x, 24, car.mesh.position.z);
        cameras.top.lookAt(car.mesh.position);
        controls.enabled = false;
    }

    const w = viewerBody.clientWidth;
    const h = viewerBody.clientHeight;

    // Reset viewport and scissor to full size
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setScissorTest(false);

    renderer.clear();
    activeCamera.aspect = w / h;
    activeCamera.updateProjectionMatrix();
    renderer.render(scene, activeCamera);
}