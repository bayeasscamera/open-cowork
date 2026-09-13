/**
 * @module main/skills/preview-manager
 * v3.5: Multi-Document Live Preview Service (PDF, DOCX, XLSX, PPTX)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DocumentPreviewPayload {
  filePath: string;
  fileType: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'unknown';
  previewType: 'pdf-stream' | 'html' | 'json-table' | 'text';
  content?: string;
  sizeBytes: number;
  lastModified: number;
}

export class DocumentPreviewManager {
  public static getSupportedExtensions(): string[] {
    return ['.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.md', '.json', '.html'];
  }

  public async generatePreview(filePath: string): Promise<DocumentPreviewPayload> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Fichier introuvable: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    let fileType: DocumentPreviewPayload['fileType'] = 'unknown';
    let previewType: DocumentPreviewPayload['previewType'] = 'text';
    let content = '';

    switch (ext) {
      case '.pdf':
        fileType = 'pdf';
        previewType = 'pdf-stream';
        content = filePath;
        break;
      case '.docx':
        fileType = 'docx';
        previewType = 'html';
        content = `<div class="docx-preview-placeholder">Aperçu document Word: ${path.basename(filePath)}</div>`;
        break;
      case '.xlsx':
      case '.csv':
        fileType = 'xlsx';
        previewType = 'json-table';
        if (ext === '.csv') {
          const raw = fs.readFileSync(filePath, 'utf-8').slice(0, 10000);
          content = raw;
        } else {
          content = `<div class="sheet-preview-placeholder">Aperçu feuille de calcul: ${path.basename(filePath)}</div>`;
        }
        break;
      case '.pptx':
        fileType = 'pptx';
        previewType = 'html';
        content = `<div class="pptx-preview-placeholder">Présentation PPTX: ${path.basename(filePath)}</div>`;
        break;
      default:
        fileType = 'unknown';
        previewType = 'text';
        content = fs.readFileSync(filePath, 'utf-8').slice(0, 50000);
    }

    return {
      filePath,
      fileType,
      previewType,
      content,
      sizeBytes: stat.size,
      lastModified: stat.mtimeMs,
    };
  }
}
