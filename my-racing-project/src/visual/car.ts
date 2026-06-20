import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export class Car {
    mesh: THREE.Group = new THREE.Group();

    // Конструктор просто ініціалізує групу
    constructor() {}

    async load(path: string): Promise<void> {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(path);
        
        const model = gltf.scene;
        model.scale.set(0.5, 0.5, 0.5);
        
        model.traverse((node) => {
            if ((node as THREE.Mesh).isMesh) {
                node.castShadow = true;
            }
        });

        this.mesh.add(model);
        model.rotation.y = - Math.PI / 2;

        // Це стрілка для мене, щоб бачити, куди дивиться модель
        // Якщо вистачить часу додам таких для відображення сил
        const arrowHelper = new THREE.ArrowHelper(
            new THREE.Vector3(0, 0, 1), // напрямок
            new THREE.Vector3(0, 0, 0), // початок
            2,                          // довжина
            0xff0000                    // колір
        );
        this.mesh.add(arrowHelper);
    }


    update(position: THREE.Vector3, direction: THREE.Vector3) {
        this.mesh.position.copy(position);
        this.mesh.lookAt(position.clone().add(direction));
    }

}