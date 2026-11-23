import axios from 'axios';

export class SmsService {
  private smsData: any;

  constructor(
    private templateId: string,
    private mobiles: string,
    private variables: { [key: string]: string }
  ) {
    this.smsData = {
      template_id: templateId,
      sender: 'KAIMSG',
      mobiles: '+91' + mobiles,
      ...variables, 
    };
  }

  async sendSms(): Promise<any> {
    const path = `https://control.msg91.com/api/v5/flow/`;

    const authkey = process.env.MSG91_AUTH_KEY ?? '';
    if (!authkey) {
      throw new Error('MSG91_AUTH_KEY not set; cannot send SMS');
    }
    const config = {
      headers: {
        accept: 'application/json',
        authkey,
        'content-type': 'application/json',
      },
    };

    try {
      // Axios .post(url, data, config)
      const response = await axios.post(path, this.smsData, config);
      
      console.log('SMS API Response:', response.data);
      return response.data;
      
    } catch (error: any) {
      // Axios error handling helps see the actual API error message
      if (axios.isAxiosError(error)) {
        console.error('SMS API Error:', error.response?.data || error.message);
      } else {
        console.error('Unexpected Error:', error);
      }
      // Optional: return false or throw error depending on how you want to handle failures
      return false; 
    }
  }
}


