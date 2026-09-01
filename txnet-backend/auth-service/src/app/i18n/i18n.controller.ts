import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { LocaleService } from '../locale/locale.service';

@Controller('i18n')
export class I18nController {
  constructor(private readonly localeService: LocaleService) {}

  @Get(':lang/:ns')
  getNamespace(@Param('lang') lang: string, @Param('ns') ns: string) {
    const data = this.localeService.getNamespace(lang, ns);
    if (!data) {
      throw new NotFoundException("system.notFound");
    }
    return data;
  }
}
