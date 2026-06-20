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
        model.scale.set(0.15, 0.15, 0.15);
        
        model.traverse((node) => {
            if ((node as THREE.Mesh).isMesh) {
                node.castShadow = true;
                const mesh = node as THREE.Mesh;
                if (mesh.material) {
                    mesh.material = (mesh.material as THREE.Material).clone();
                    const mat = mesh.material as THREE.MeshStandardMaterial;
                    
                    const isBody = node.name.match(/^Object_(4|5|6|7|8|9|1[0-9]|20)$/) || 
                                   (node.parent && node.parent.name.includes('Cube.001'));
                    if (isBody) {
                        mat.color.setHex(0xe10600); // F1 racing red
                        mat.roughness = 0.2;
                        mat.metalness = 0.8;
                    } else {
                        mat.color.setHex(0x151515); // carbon black/wheels
                        mat.roughness = 0.8;
                        mat.metalness = 0.2;
                    }
                }
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