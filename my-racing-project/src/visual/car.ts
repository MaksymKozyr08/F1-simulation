import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export class Car {
    mesh: THREE.Group = new THREE.Group();

    // Just initializes the groop
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

        const arrowHelper = new THREE.ArrowHelper(
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(0, 0, 0),
            2,
            0xff0000
        );
        this.mesh.add(arrowHelper);
    }


    update(position: THREE.Vector3, direction: THREE.Vector3, state: any) {

        //!!!!!!!!!!!!!!! If it follows the lign !!!!!!!!!!!!!!!!!!!!!!!
        this.mesh.position.copy(position);
        this.mesh.lookAt(position.clone().add(direction));
        //!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    }

}