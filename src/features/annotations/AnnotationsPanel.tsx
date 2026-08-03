import { AnnotationBookmarkSection } from './AnnotationBookmarkSection';
import { AnnotationHighlightSection } from './AnnotationHighlightSection';
import { AnnotationNoteSection } from './AnnotationNoteSection';
import { AnnotationPanelControls } from './AnnotationPanelControls';
import type { AnnotationsController } from './useAnnotationsController';
import './annotations-panel.css';

export default function AnnotationsPanel({ controller }: { controller: AnnotationsController }) {
  return (
    <div className="panel-body annotation-panel">
      <h3>주석</h3>
      <AnnotationPanelControls controller={controller} />
      <AnnotationBookmarkSection controller={controller} />
      <AnnotationHighlightSection controller={controller} />
      <AnnotationNoteSection controller={controller} />
    </div>
  );
}
