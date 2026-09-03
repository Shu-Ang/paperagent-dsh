import type { PaperFigureRecord } from './models.ts'

/** Builds the stable text projection indexed for figure retrieval. */
export function figureFtsText(figure: Pick<PaperFigureRecord, 'figureLabel' | 'sectionTitle' | 'rawCaption' | 'nearbyText' | 'visionDescription'>): string {
  return [figure.figureLabel ?? '', figure.sectionTitle, figure.rawCaption, figure.visionDescription ?? '', figure.nearbyText].filter(Boolean).join('\n')
}
