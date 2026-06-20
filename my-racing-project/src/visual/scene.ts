import * as THREE from 'three';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);

// Щоб моделі не були тьмяні
renderer.toneMapping = THREE.ACESFilmicToneMapping; 
renderer.toneMappingExposure = 1.2; 
// Для правильної передачі кольору
renderer.outputColorSpace = THREE.SRGBColorSpace;

document.body.appendChild(renderer.domElement);

// Камери
export const cameras = {
    front: new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000),
    top: new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000),
    inside: new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
};

cameras.front.position.set(15, 15, 15); 
cameras.front.lookAt(0, 0, 0);
cameras.top.position.set(0, 30, 0); 
cameras.top.lookAt(0, 0, 0);

// Сіточка
const grid = new THREE.GridHelper(500, 500, 0x444444, 0x222222);
scene.add(grid);

// Світло та тіні
// DirectionalLight
const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
dirLight.position.set(15, 25, 15);
dirLight.castShadow = true;

// |Трошки тіней 
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

// AmbientLight
const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

// HemiLight
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
scene.add(hemiLight);

