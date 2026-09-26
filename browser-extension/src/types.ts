export type ClipTarget =
  | {
      kind: "arxiv";
      value: string;
    }
  | {
      kind: "doi";
      value: string;
    }
  | {
      kind: "pdf";
      value: string;
    };

export interface ClipPreview {
  site: "arxiv";

  target: ClipTarget;

  title: string;
  authors: string[];

  abstract?: string;
  doi?: string;
  pdfUrl?: string;

  canonicalUrl: string;
}

export interface GetClipPreviewMessage {
  type: "LINXIV_GET_CLIP_PREVIEW";
}