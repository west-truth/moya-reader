import { Component, type HTMLAttributes, type RefObject } from 'react';

interface Props extends HTMLAttributes<HTMLDivElement> {
  enabled: boolean;
  geometry: unknown;
  sectionKey: string;
  viewportRef: RefObject<HTMLElement>;
  contentRef: RefObject<HTMLDivElement>;
}
export interface ComicFlowAnchor {
  element: HTMLElement;
  documentTop: number;
  scrollTop: number;
}
export function captureComicFlowAnchor(viewport: HTMLElement, content: HTMLElement): ComicFlowAnchor | null {
  const top = viewport.getBoundingClientRect().top;
  const element = [...content.querySelectorAll<HTMLElement>('article[data-page-index]')].find(
    (row) => row.getBoundingClientRect().bottom > top,
  );
  return element
    ? { element, documentTop: element.getBoundingClientRect().top + viewport.scrollTop, scrollTop: viewport.scrollTop }
    : null;
}
export function restoreComicFlowAnchor(viewport: HTMLElement, anchor: ComicFlowAnchor) {
  if (!anchor.element.isConnected) return;
  const movement = anchor.element.getBoundingClientRect().top + viewport.scrollTop - anchor.documentTop;
  viewport.scrollTop = anchor.scrollTop + movement;
}

/** Snapshot before DOM mutation, not when an asynchronous image finishes:
 * React may defer that render while the user keeps scrolling. A layout effect
 * is also too late if shrinking content has already clamped scrollTop.
 */
export class ComicPageFlow extends Component<Props, Record<string, never>, ComicFlowAnchor | null> {
  getSnapshotBeforeUpdate(previous: Props): ComicFlowAnchor | null {
    const { enabled, geometry, sectionKey, viewportRef, contentRef } = this.props;
    if (!enabled || !previous.enabled || previous.geometry === geometry || previous.sectionKey !== sectionKey)
      return null;
    return viewportRef.current && contentRef.current
      ? captureComicFlowAnchor(viewportRef.current, contentRef.current)
      : null;
  }
  componentDidUpdate(_previous: Props, _state: Record<string, never>, anchor: ComicFlowAnchor | null) {
    if (anchor && this.props.viewportRef.current) restoreComicFlowAnchor(this.props.viewportRef.current, anchor);
  }
  render() {
    const {
      enabled: _enabled,
      geometry: _geometry,
      sectionKey: _sectionKey,
      viewportRef: _viewportRef,
      contentRef,
      ...props
    } = this.props;
    return <div {...props} ref={contentRef} />;
  }
}
