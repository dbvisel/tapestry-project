import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { memo, useEffect, useRef } from 'react'
import { TapestryElementComponentProps, useTapestryConfig } from '../..'
import { Model3dItem as Model3dItemDto } from 'tapestry-core/src/data-format/schemas/item'
import { useResizeObserver } from '../../../lib/hooks/use-resize-observer'

const BACKGROUND_COLOR = 0x1a1a1a
const MODEL_COLOR = 0xb0b0b0

/**
 * Renders an STL 3D model with three.js: a plain mesh with no material/color data of its own (that's all
 * STL geometry contains), so it's given a neutral grey physically-based material and three-point lighting -
 * the standard appearance convention most STL viewers use. Orbit/pan/zoom is handled by `OrbitControls`.
 */
export const Model3dItemViewer = memo(({ id }: TapestryElementComponentProps) => {
  const { useStoreData } = useTapestryConfig()
  const { source } = useStoreData(`items.${id}.dto`) as Model3dItemDto
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element || !source) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(BACKGROUND_COLOR)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    element.appendChild(renderer.domElement)
    rendererRef.current = renderer

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const keyLight = new THREE.DirectionalLight(0xffffff, 1)
    keyLight.position.set(1, 1, 1)
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-1, -0.5, -1)
    scene.add(fillLight)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    let mesh: THREE.Mesh | undefined
    let animationFrame: number
    let disposed = false

    new STLLoader().load(
      source,
      (geometry) => {
        if (disposed) return

        geometry.computeVertexNormals()
        geometry.center()
        geometry.computeBoundingSphere()

        const material = new THREE.MeshStandardMaterial({
          color: MODEL_COLOR,
          metalness: 0.1,
          roughness: 0.7,
        })
        mesh = new THREE.Mesh(geometry, material)
        scene.add(mesh)

        // Frame the camera around the model's bounding sphere, since STL files carry no camera/scale info.
        const radius = geometry.boundingSphere?.radius || 1
        camera.position.set(radius * 2, radius * 1.5, radius * 2)
        camera.near = radius / 100
        camera.far = radius * 100
        camera.updateProjectionMatrix()
        controls.target.set(0, 0, 0)
        controls.update()
      },
      undefined,
      (error) => console.warn(`Failed to load STL model from ${source}`, error),
    )

    function render() {
      animationFrame = requestAnimationFrame(render)
      controls.update()
      renderer.render(scene, camera)
    }
    render()

    return () => {
      disposed = true
      cancelAnimationFrame(animationFrame)
      controls.dispose()
      mesh?.geometry.dispose()
      ;(mesh?.material as THREE.Material | undefined)?.dispose()
      renderer.dispose()
      element.removeChild(renderer.domElement)
    }
  }, [source])

  useResizeObserver({
    ref: containerRef,
    callback: (_entries, target) => {
      const renderer = rendererRef.current
      const camera = cameraRef.current
      if (!renderer || !camera || target.clientWidth === 0 || target.clientHeight === 0) return

      renderer.setSize(target.clientWidth, target.clientHeight)
      camera.aspect = target.clientWidth / target.clientHeight
      camera.updateProjectionMatrix()
    },
  })

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
})
