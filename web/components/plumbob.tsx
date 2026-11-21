'use client'

import { useEffect, useRef } from 'react'

import { VIOLET } from './dither'
import { plumbobFragmentShader, vertexShader } from './dither-shader'

const DEEP_VIOLET = [0.43, 0.25, 0.82] as const

interface PlumbobProps {
  className?: string
  /** Size of one dither cell in CSS pixels. */
  pixelSize?: number
  /** Rotation speed in radians per second. */
  spinSpeed?: number
  /** Intensity of the subtle outer Bayer dither halo (0 disables it). */
  aura?: number
  /** Camera zoom factor (smaller zooms in). */
  zoom?: number
}

const UNIFORMS = [
  'resolution',
  'time',
  'waveFrequency',
  'waveAmplitude',
  'spinAngle',
  'bobOffset',
  'auraStrength',
  'zoom',
  'mousePos',
  'mouseActive',
  'shadowColor',
  'deepColor',
  'waveColor',
  'highlightColor',
] as const

function createProgram(gl: WebGLRenderingContext) {
  const program = gl.createProgram()
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexShader],
    [gl.FRAGMENT_SHADER, plumbobFragmentShader],
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null
}

export function Plumbob({
  className,
  pixelSize = 3,
  spinSpeed = 0.68,
  aura = 0.8,
  zoom = 0.9,
}: PlumbobProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef({ spinSpeed, aura, zoom })
  propsRef.current = { spinSpeed, aura, zoom }

  useEffect(() => {
    const canvas = canvasRef.current
    const gl = canvas?.getContext('webgl', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: true,
      premultipliedAlpha: true,
    })
    if (!canvas || !gl) return
    const program = createProgram(gl)
    if (!program) return

    gl.useProgram(program)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const uniforms = Object.fromEntries(
      UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const pointer = { x: -1, y: -1, targetX: -1, targetY: -1, active: false }
    let frame = 0
    let visible = true
    let elapsed = 1.4
    let spinAngle = 0.14
    let last = performance.now()

    const draw = (now: number) => {
      const width = Math.max(1, Math.round(canvas.clientWidth / pixelSize))
      const height = Math.max(1, Math.round(canvas.clientHeight / pixelSize))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const props = propsRef.current
      if (!reducedMotion.matches) {
        elapsed += dt
        spinAngle += dt * props.spinSpeed
      }
      pointer.x += (pointer.targetX - pointer.x) * 0.1
      pointer.y += (pointer.targetY - pointer.y) * 0.1

      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform2f(uniforms.resolution, width, height)
      gl.uniform1f(uniforms.time, elapsed)
      gl.uniform1f(uniforms.waveFrequency, 3)
      gl.uniform1f(uniforms.waveAmplitude, 0.3)
      gl.uniform1f(uniforms.spinAngle, spinAngle)
      gl.uniform1f(uniforms.bobOffset, reducedMotion.matches ? 0 : Math.sin(elapsed * 1.9) * 0.04)
      gl.uniform1f(uniforms.auraStrength, props.aura)
      gl.uniform1f(uniforms.zoom, props.zoom)
      gl.uniform2f(uniforms.mousePos, pointer.x, pointer.y)
      gl.uniform1f(uniforms.mouseActive, pointer.active ? 1 : 0)
      gl.uniform3f(uniforms.shadowColor, ...VIOLET.shadow)
      gl.uniform3f(uniforms.deepColor, ...DEEP_VIOLET)
      gl.uniform3f(uniforms.waveColor, ...VIOLET.color)
      gl.uniform3f(uniforms.highlightColor, ...VIOLET.highlight)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      frame = visible && !reducedMotion.matches ? requestAnimationFrame(draw) : 0
    }

    const start = () => {
      if (frame || !visible || reducedMotion.matches) return
      last = performance.now()
      frame = requestAnimationFrame(draw)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!visible) return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      pointer.targetX = (event.clientX - rect.left) / rect.width
      pointer.targetY = 1 - (event.clientY - rect.top) / rect.height
      pointer.active = true
    }

    const handlePointerLeave = () => {
      pointer.active = false
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true
      if (visible) start()
    })
    observer.observe(canvas)
    if (!reducedMotion.matches) {
      canvas.addEventListener('pointermove', handlePointerMove, { passive: true })
      canvas.addEventListener('pointerleave', handlePointerLeave)
    }
    draw(last)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerleave', handlePointerLeave)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    }
  }, [pixelSize])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={
        className ? `fleet-dither fleet-plumbob ${className}` : 'fleet-dither fleet-plumbob'
      }
    />
  )
}
