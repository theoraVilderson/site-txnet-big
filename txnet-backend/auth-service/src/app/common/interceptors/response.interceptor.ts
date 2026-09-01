import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { LocaleService } from '../../locale/locale.service';

/**
 * Intercepts all successful responses, wraps them in ok() if not already wrapped,
 * and translates the `msg` field using the request's language.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly localeService: LocaleService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const lang =
      (request as any).language || this.localeService.getDefaultLanguage();

    return next.handle().pipe(
      map((data) => {
        // If response is already wrapped (has ok and msg), just translate msg
        if (data && typeof data === 'object' && 'ok' in data) {
          const msgKey = data.msg;
          if (typeof msgKey === 'string') {
            data.msg =
              this.localeService.getKey(lang, 'messages', msgKey) || msgKey;
          }
          return data;
        }

        // Otherwise, wrap in ok() with default success message key
        const defaultMsgKey = 'successful';
        return {
          ok: true,
          msg:
            this.localeService.getKey(lang, 'messages', defaultMsgKey) ||
            'successful',
          data,
        };
      }),
    );
  }
}
