import axios, { type AxiosInstance } from 'axios';
import { replaceVar } from './helper';
import {
  err,
  ok,
  type ResponseType,
} from '../../../../common/response/response.util';

export class SmsProviderService {
  private apiBaseURL: string;
  private apiKey: string;
  private username: string;
  private password: string;
  private req: AxiosInstance;

  constructor(apiUrl: string, apiKey: string) {
    this.apiBaseURL = apiUrl;
    this.apiKey = apiKey;
    const [username, password] = this.apiKey.split('@');
    this.username = username!;
    this.password = password!;
    this.req = axios.create({
      baseURL: this.apiBaseURL,
    });
  }

  async sendSMS(
    {
      msg,
      to,
      vars = {},
    }: {
      msg: string;
      to: string;
      vars?: { [key: string]: string | number };
    },
    sender: string,
    force = true,
  ): Promise<ResponseType<boolean>> {
    // مشخص کردن دقیق خروجی متد

    if (!force) {
      return ok(true, 'send on sucessfully in development mode');
    }

    const isHaveVariable = Object.keys(vars).length !== 0;
    if (isHaveVariable) {
      msg = replaceVar(msg, vars);
    }

    const info = {
      UserName: this.username,
      Password: this.password,
      From: sender,
      To: to,
      Message: msg,
    };

    try {
      const response = await this.req.get('/SendSms', { params: info });
      const resultData = response.data;

      if (resultData === 'SendWasSuccessful') {
        return ok(true, 'SMS sent Successfuly');
      }

      return err(resultData, null);
    } catch (e) {
      return err('SMS failed to sent', e);
    }
  }
}
