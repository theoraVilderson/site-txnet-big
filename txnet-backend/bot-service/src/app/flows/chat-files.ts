import { Injectable } from '@nestjs/common';
import { BotClientRegistry, BotIncomingFile } from '@txnet-backend/messenger';
import { ChatContext } from '../conversation/nav.types';
import { OutgoingFile } from '../support-api/support-api.client';

/**
 * Both platforms let a bot fetch 20 MB (`getFile`). Larger is refused before
 * the download; what support itself takes is support's to say.
 */
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * A file a user sent into the chat, fetched from the platform it arrived on
 * (F-309). The name and type are the sender's claim — support sniffs the
 * bytes and decides; this only gives a photo, which arrives nameless and as
 * JPEG on both platforms, a name and that type.
 */
@Injectable()
export class ChatFiles {
  constructor(private readonly bots: BotClientRegistry) {}

  /** The bytes, or `null` when the platform would not hand them over. */
  async download(ctx: ChatContext, file: BotIncomingFile): Promise<OutgoingFile | null> {
    if ((file.sizeBytes ?? 0) > CHAT_FILE_MAX_BYTES) return null;
    const client = await this.bots.client(ctx.integration, 'bot-app:ChatFiles');
    const bytes = await client?.downloadFile(file.fileId, CHAT_FILE_MAX_BYTES);
    if (!bytes) return null;
    return file.kind === 'photo'
      ? { fileName: 'photo.jpg', contentType: 'image/jpeg', bytes }
      : { fileName: file.fileName || 'file', contentType: file.mimeType || 'application/octet-stream', bytes };
  }
}
