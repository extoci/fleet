'use client'

import { useEffect, useRef } from 'react'

import { fragmentShader, vertexShader } from './dither-shader'

type Rgb = readonly [number, number, number]

/** Fleet's violet from the extoci.com project rows: shadow, main colour, highlight. */
export const VIOLET = {
  shadow: [0.2, 0.09, 0.36] as Rgb,
  color: [0.66, 0.45, 0.98] as Rgb,
  highlight: [0.9, 0.82, 1] as Rgb,
}

interface DitherProps {
  className?: string
  /** Where the field is densest, as a fraction of the canvas from its bottom-left corner. */
  focus?: [number, number]
  /** Size of the ellipse the field fades out within, as fractions of the canvas. */
  spread?: [number, number]
  gain?: number
  /** Size of one dither cell in CSS pixels. */
  pixelSize?: number
  speed?: number
  /** Shifts the pattern so neighbouring fields do not repeat. */
  seed?: number
  /** When false the field renders a single static frame and never loops. */
  active?: boolean
}

const UNIFORMS = [
  'resolution',
  'time',
  'waveSpeed',
  'waveFrequency',
  'waveAmplitude',
  'waveColor',
  'shadowColor',
  'highlightColor',
  'gain',
  'mousePos',
  'mouseRadius',
  'focus',
  'spread',
  'colorNum',
  'pixelSize',
  'seed',
] as const

function createProgram(gl: WebGLRenderingContext) {
  const program = gl.createProgram()
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexShader],
    [gl.FRAGMENT_SHADER, fragmentShader],
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

export function Dither({
  className,
  focus = [0.5, 0.5],
  spread = [1, 1],
  gain = 1.3,
  pixelSize = 3,
  speed = 0.05,
  seed = 0,
  active = true,
}: DitherProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const startRef = useRef<() => void>(() => {})
  const propsRef = useRef({ focus, spread, gain, speed, seed, active })
  propsRef.current = { focus, spread, gain, speed, seed, active }

  useEffect(() => {
    const canvas = canvasRef.current
    const gl = canvas?.getContext('webgl', {
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
    })
    if (!canvas || !gl) return
    const program = createProgram(gl)
    if (!program) return

    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
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
    // The pointer starts off-canvas and eases toward the cursor.
    const pointer = { x: -1, y: -1, targetX: -1, targetY: -1 }
    let frame = 0
    let visible = true
    let elapsed = 0
    let last = performance.now()

    const draw = (now: number) => {
      // One canvas pixel per dither cell, scaled up crisply by CSS.
      const width = Math.max(1, Math.round(canvas.clientWidth / pixelSize))
      const height = Math.max(1, Math.round(canvas.clientHeight / pixelSize))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
      if (!reducedMotion.matches) elapsed += (now - last) / 1000
      last = now
      pointer.x += (pointer.targetX - pointer.x) * 0.08
      pointer.y += (pointer.targetY - pointer.y) * 0.08

      const props = propsRef.current
      gl.uniform2f(uniforms.resolution, width, height)
      gl.uniform1f(uniforms.time, elapsed)
      gl.uniform1f(uniforms.waveSpeed, props.speed)
      gl.uniform1f(uniforms.waveFrequency, 3)
      gl.uniform1f(uniforms.waveAmplitude, 0.3)
      gl.uniform3f(uniforms.shadowColor, ...VIOLET.shadow)
      gl.uniform3f(uniforms.waveColor, ...VIOLET.color)
      gl.uniform3f(uniforms.highlightColor, ...VIOLET.highlight)
      gl.uniform1f(uniforms.gain, props.gain)
      gl.uniform2f(uniforms.mousePos, pointer.x, pointer.y)
      gl.uniform1f(uniforms.mouseRadius, 0.28)
      gl.uniform2f(uniforms.focus, ...props.focus)
      gl.uniform2f(uniforms.spread, ...props.spread)
      gl.uniform1f(uniforms.seed, props.seed)
      gl.uniform1f(uniforms.colorNum, 5)
      gl.uniform1f(uniforms.pixelSize, 1)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      frame =
        visible && propsRef.current.active && !reducedMotion.matches
          ? requestAnimationFrame(draw)
          : 0
    }

    const start = () => {
      if (frame || !visible || !propsRef.current.active || reducedMotion.matches) return
      last = performance.now()
      frame = requestAnimationFrame(draw)
    }
    startRef.current = start
    const handlePointerMove = (event: PointerEvent) => {
      if (!visible || !propsRef.current.active) return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      pointer.targetX = (event.clientX - rect.left) / rect.width
      pointer.targetY = 1 - (event.clientY - rect.top) / rect.height
    }
    // Stop drawing while the canvas is scrolled out of view.
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true
      if (visible) start()
    })
    observer.observe(canvas)
    if (!reducedMotion.matches) {
      window.addEventListener('pointermove', handlePointerMove, { passive: true })
    }
    draw(last)

    return () => {
      startRef.current = () => {}
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('pointermove', handlePointerMove)
      gl.deleteProgram(program)
    }
  }, [pixelSize])

  // Resume the loop when a field switches on; the draw guard stops it when it switches off.
  useEffect(() => {
    if (active) startRef.current()
  }, [active])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className ? `fleet-dither ${className}` : 'fleet-dither'}
    />
  )
}
