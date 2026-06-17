import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import { createPanZoom } from "../composables/create-pan-zoom.ts";
import { ZoomControls } from "./zoom-controls.tsx";

// Worker asset URL. Vite emits the worker as a standalone file and hands
// back a URL it can resolve under Tauri's asset/file protocol and in the
// web builds. This is only a string — the heavy pdfjs runtime stays out
// of the initial bundle and is pulled in lazily on the first PDF open.
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const SCALE_STEP = 0.25;

export interface MediaViewerProps {
  kind: "image" | "pdf";
  /** Asset URL the webview can load, already resolved by the host
   *  (desktop via `convertFileSrc`). Null when the host can't resolve it. */
  src: string | null;
  fileName: string;
}

function clampScale(n: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
}

/**
 * Builtin viewer for binary files the editor/preview pipeline can't handle.
 * Images render straight into an `<img>` off the asset URL; PDFs are drawn
 * with pdf.js (bundled so rendering is identical across macOS/Windows/Linux,
 * where the webview's native PDF support is inconsistent) as a single
 * continuously-scrollable column of pages. No Tauri imports here — the host
 * injects the resolved `src`, keeping this component usable from the
 * web/extension builds too.
 */
export function MediaViewer(props: MediaViewerProps) {
  // PDF zoom: an absolute scale we re-rasterize the pages at (+ fit-to-width).
  // Images use the shared pan-zoom hook below instead — transform-based, pannable.
  const [scale, setScale] = createSignal(1);
  // Image-only: fit-to-container mode (CSS object-fit). Zooming exits it.
  const [fit, setFit] = createSignal(true);
  const [imageError, setImageError] = createSignal(false);
  // Image zoom + pan via `transform: translate(tx,ty) scale(scale)`. Multiplicative
  // step, clamped to the same MIN/MAX as the PDF path; cursor-anchored wheel +
  // drag-to-pan. Replaces the old naturalWidth-gated width/transform fork (which
  // silently fell back to a paint-only, un-scrollable transform → "zoom stops at
  // 100%") with one mechanism that always works.
  const imageZoom = createPanZoom({ minScale: MIN_SCALE, maxScale: MAX_SCALE });

  const [pageCount, setPageCount] = createSignal(0);
  const [pdfError, setPdfError] = createSignal<string | null>(null);
  const [pdfLoading, setPdfLoading] = createSignal(false);

  let pdfDoc: PDFDocumentProxy | null = null;
  let basePageWidth = 0;
  let stageRef: HTMLDivElement | undefined;
  const canvasRefs: (HTMLCanvasElement | undefined)[] = [];
  let renderGen = 0;
  let renderTasks: RenderTask[] = [];

  function cancelRenders() {
    for (const t of renderTasks) {
      try {
        t.cancel();
      } catch {
        // already settled
      }
    }
    renderTasks = [];
  }

  // Scale that makes a page fill the stage width (minus padding). Falls back
  // to 1 before the stage is measured or the doc's base width is known.
  function computeFitScale(): number {
    if (stageRef && basePageWidth) {
      const avail = stageRef.clientWidth - 32;
      if (avail > 0) return clampScale(avail / basePageWidth);
    }
    return 1;
  }

  // Load (or tear down) the PDF whenever the source or kind changes —
  // covers reusing the same pane for a different file.
  createEffect(
    on(
      () => [props.kind, props.src] as const,
      async ([kind, src]) => {
        cancelRenders();
        if (pdfDoc) {
          void pdfDoc.destroy();
          pdfDoc = null;
        }
        setScale(1);
        imageZoom.reset();
        setFit(props.kind === "image");
        setImageError(false);
        setPdfError(null);
        setPageCount(0);
        canvasRefs.length = 0;
        if (kind !== "pdf" || !src) return;

        setPdfLoading(true);
        try {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;
          const doc = await pdfjs.getDocument(src).promise;
          // A newer load may have superseded this one mid-await.
          if (src !== props.src) {
            void doc.destroy();
            return;
          }
          pdfDoc = doc;
          const first = await doc.getPage(1);
          basePageWidth = first.getViewport({ scale: 1 }).width;
          setScale(computeFitScale());
          // Mounting the canvases (via pageCount) drives the render effect.
          setPageCount(doc.numPages);
        } catch (e) {
          // Surfaces genuinely broken/mislabeled files (e.g. a .pdf that is
          // actually text → pdf.js throws InvalidPDFException) without a
          // silent blank canvas.
          console.error("[MediaViewer] failed to load PDF:", (e as Error)?.message ?? e);
          setPdfError((e as Error)?.message ?? String(e));
        } finally {
          setPdfLoading(false);
        }
      },
    ),
  );

  // Render every page into its canvas on load and on zoom change. Pages are
  // drawn sequentially; a generation counter + task cancellation bail out
  // when a newer render (zoom or file switch) supersedes this pass.
  createEffect(
    on(
      () => [pageCount(), scale()] as const,
      async ([count]) => {
        if (props.kind !== "pdf" || !pdfDoc || count === 0) return;
        const gen = ++renderGen;
        cancelRenders();
        // Let the <For> mount its canvases before we reach for the refs.
        await Promise.resolve();
        for (let i = 1; i <= count; i++) {
          if (gen !== renderGen) return;
          const canvas = canvasRefs[i - 1];
          if (!canvas) continue;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          try {
            const page = await pdfDoc.getPage(i);
            if (gen !== renderGen) return;
            const viewport = page.getViewport({ scale: scale() });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const task = page.render({ canvasContext: ctx, viewport, canvas });
            renderTasks.push(task);
            await task.promise;
          } catch {
            // RenderingCancelledException fires on superseded renders — benign.
          }
        }
      },
    ),
  );

  onCleanup(() => {
    cancelRenders();
    if (pdfDoc) void pdfDoc.destroy();
  });

  // Zoom dispatches to the right engine: images use the pan-zoom hook
  // (multiplicative step + drag-to-pan), PDFs re-rasterize at an absolute scale.
  function zoomIn() {
    if (props.kind === "image") {
      setFit(false);
      imageZoom.zoomIn();
    } else setScale((s) => clampScale(s + SCALE_STEP));
  }
  function zoomOut() {
    if (props.kind === "image") {
      setFit(false);
      imageZoom.zoomOut();
    } else setScale((s) => clampScale(s - SCALE_STEP));
  }
  function fitView() {
    if (props.kind === "image") {
      setFit(true);
      imageZoom.reset();
      return;
    }
    setScale(computeFitScale());
  }

  // Wheel / trackpad-pinch zoom on the image; the first tick leaves fit mode so
  // the transform takes over from object-fit.
  function onImageWheel(e: WheelEvent) {
    if (fit()) setFit(false);
    imageZoom.handlers.onWheel(e);
  }
  function onImagePointerDown(e: PointerEvent) {
    if (fit()) return; // nothing is transformed in fit mode, so there's nothing to pan
    imageZoom.handlers.onPointerDown(e);
  }

  const displayScale = () => (props.kind === "image" ? imageZoom.scale() : scale());
  const zoomLabel = () =>
    fit() && props.kind === "image" ? m.media_fit_label() : `${Math.round(displayScale() * 100)}%`;
  const zoomOutDisabled = () => !fit() && displayScale() <= MIN_SCALE;
  const zoomInDisabled = () => !fit() && displayScale() >= MAX_SCALE;

  // Images: pan + zoom via ONE transform (no naturalWidth race). Fit mode returns
  // undefined so CSS object-fit governs. PDFs never hit this — their canvases are
  // rasterized at `scale` instead.
  const imageStyle = () =>
    fit()
      ? undefined
      : { transform: `translate(${imageZoom.tx()}px, ${imageZoom.ty()}px) scale(${imageZoom.scale()})` };

  return (
    <div class="media-viewer">
      <div class="media-toolbar no-print">
        <span class="media-filename" title={props.fileName}>{props.fileName}</span>
        <Show when={props.kind === "pdf" && pageCount() > 0}>
          <span class="media-page-value">
            {pageCount()} {(useLocale(), pageCount() === 1 ? m.media_page() : m.media_pages())}
          </span>
        </Show>
        <div class="media-toolbar-spacer" />
        <ZoomControls
          scale={displayScale()}
          label={(useLocale(), zoomLabel())}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          zoomInDisabled={zoomInDisabled()}
          zoomOutDisabled={zoomOutDisabled()}
          onFit={fitView}
          zoomInLabel={(useLocale(), m.media_zoom_in())}
          zoomOutLabel={(useLocale(), m.media_zoom_out())}
          fitLabel={(useLocale(), props.kind === "pdf" ? m.media_fit_width() : m.media_fit_window())}
        />
      </div>

      <Show
        when={props.kind === "image"}
        fallback={
          <div class="media-stage" ref={stageRef}>
            <Show
              when={props.src}
              fallback={<div class="media-message">{(useLocale(), m.media_unable_to_load({ name: props.fileName }))}</div>}
            >
              <Show
                when={!pdfError()}
                fallback={<div class="media-message">{(useLocale(), m.media_unable_to_display({ name: props.fileName }))}</div>}
              >
                <Show when={pdfLoading() && pageCount() === 0}>
                  <div class="media-message">{(useLocale(), m.media_loading())}</div>
                </Show>
                <div class="media-pdf-doc">
                  <For each={Array.from({ length: pageCount() }, (_, i) => i)}>
                    {(i) => (
                      <canvas
                        class="media-pdf-page"
                        ref={(el) => (canvasRefs[i] = el)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        }
      >
        {/* Pannable image stage: clipped (overflow:hidden) with the zoomed image
            moved by transform — drag to pan, wheel/pinch to zoom (see onImage*). */}
        <div
          class="media-stage media-stage-image"
          classList={{ "media-stage-pan": !fit(), "is-grabbing": imageZoom.dragging() }}
          ref={(el) => imageZoom.setContainer(el)}
          onWheel={onImageWheel}
          onPointerDown={onImagePointerDown}
          onPointerMove={imageZoom.handlers.onPointerMove}
          onPointerUp={imageZoom.handlers.onPointerUp}
          onPointerCancel={imageZoom.handlers.onPointerCancel}
        >
          <Show
            when={props.src}
            fallback={<div class="media-message">{(useLocale(), m.media_unable_to_load({ name: props.fileName }))}</div>}
          >
            <Show
              when={!imageError()}
              fallback={<div class="media-message">{(useLocale(), m.media_unable_to_display({ name: props.fileName }))}</div>}
            >
              <img
                class="media-image"
                classList={{ "media-image-fit": fit() }}
                src={props.src!}
                alt={props.fileName}
                style={imageStyle()}
                onError={() => setImageError(true)}
              />
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
