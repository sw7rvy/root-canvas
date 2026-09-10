import * as THREE from 'three';
import { Emitter, type Unsubscribe } from './Emitter';
import type { View, ViewRegistry } from './View';

export interface PointerPayload {
  type: keyof PointerEvents;
  view: View;
  ndc: THREE.Vector2;
  client: THREE.Vector2;
  local: THREE.Vector2;
  originalEvent: PointerEvent | MouseEvent | WheelEvent;
  raycaster: THREE.Raycaster;
  intersect: (objects?: THREE.Object3D[], recursive?: boolean) => THREE.Intersection[];
}

export interface PointerEvents {
  pointermove: PointerPayload;
  pointerdown: PointerPayload;
  pointerup: PointerPayload;
  pointerenter: PointerPayload;
  pointerleave: PointerPayload;
  click: PointerPayload;
  wheel: PointerPayload;
}

const SOURCE_EVENTS = ['pointermove', 'pointerdown', 'pointerup', 'click', 'wheel'] as const;

export class PointerPipeline {
  readonly events = new Emitter<PointerEvents>();

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly client = new THREE.Vector2();
  private readonly local = new THREE.Vector2();
  private hovered: View | null = null;
  private attached = false;

  constructor(
    private readonly registry: ViewRegistry,
    private readonly target: EventTarget = window,
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    for (const type of SOURCE_EVENTS) {
      this.target.addEventListener(type, this.handle as EventListener, { passive: true });
    }
    this.target.addEventListener('pointercancel', this.handleLeave as EventListener, { passive: true });
    document.addEventListener('pointerleave', this.handleLeave as EventListener, { passive: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const type of SOURCE_EVENTS) {
      this.target.removeEventListener(type, this.handle as EventListener);
    }
    this.target.removeEventListener('pointercancel', this.handleLeave as EventListener);
    document.removeEventListener('pointerleave', this.handleLeave as EventListener);
  }

  on<K extends keyof PointerEvents>(type: K, handler: (payload: PointerEvents[K]) => void): Unsubscribe {
    return this.events.on(type, handler);
  }

  dispose(): void {
    this.detach();
    this.events.clear();
    this.hovered = null;
  }

  private build(type: keyof PointerEvents, view: View, event: PointerEvent | MouseEvent | WheelEvent): PointerPayload {
    const { left, top, width, height } = view.rect;
    this.client.set(event.clientX, event.clientY);
    this.local.set(event.clientX - left, event.clientY - top);
    this.ndc.set((this.local.x / width) * 2 - 1, -(this.local.y / height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, view.camera);

    return {
      type,
      view,
      ndc: this.ndc.clone(),
      client: this.client.clone(),
      local: this.local.clone(),
      originalEvent: event,
      raycaster: this.raycaster,
      intersect: (objects, recursive = true) =>
        this.raycaster.intersectObjects(objects ?? view.scene.children, recursive),
    };
  }

  private dispatch(type: keyof PointerEvents, view: View, event: PointerEvent | MouseEvent | WheelEvent): void {
    const payload = this.build(type, view, event);
    view.events.emit(type, payload);
    this.events.emit(type, payload);
  }

  private handle = (event: PointerEvent | MouseEvent | WheelEvent): void => {
    const type = event.type as keyof PointerEvents;
    const view = this.registry.hitTest(event.clientX, event.clientY);

    if (type === 'pointermove' || type === 'wheel') {
      if (view !== this.hovered) {
        if (this.hovered) this.dispatch('pointerleave', this.hovered, event);
        this.hovered = view;
        if (view) this.dispatch('pointerenter', view, event);
      }
    }

    if (!view) return;
    this.dispatch(type, view, event);
  };

  private handleLeave = (event: PointerEvent): void => {
    if (!this.hovered) return;
    this.dispatch('pointerleave', this.hovered, event);
    this.hovered = null;
  };
}
