import moment from 'moment';
import { type Page } from 'puppeteer';
import { randomUUID } from 'crypto';
import { getDebug } from '../helpers/debug';
import { fetchGetWithinPage, fetchPostWithinPage } from '../helpers/fetch';
import { getCurrentUrl } from '../helpers/navigation';
import { sleep, waitUntil } from '../helpers/waiting';
import { type Transaction, TransactionStatuses, TransactionTypes, type TransactionsAccount } from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type PossibleLoginResults } from './base-scraper-with-browser';
import { ScraperErrorTypes } from './errors';
import { OTP_RESEND, type OtpCodeRetriever, type ScraperLoginResult, type ScraperOptions } from './interface';
import { getRawTransaction } from '../helpers/transactions';

const debug = getDebug('hapoalim');

const DATE_FORMAT = 'YYYYMMDD';

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace window {
  const bnhpApp: any;
}

interface ScrapedTransaction {
  serialNumber?: number;
  activityDescription?: string;
  eventAmount: number;
  valueDate?: string;
  eventDate?: string;
  referenceNumber?: number;
  ScrapedTransaction?: string;
  eventActivityTypeCode: number;
  currentBalance: number;
  pfmDetails: string;
  beneficiaryDetailsData?: {
    partyHeadline?: string;
    partyName?: string;
    messageHeadline?: string;
    messageDetail?: string;
  };
  additionalInformation?: unknown;
}

interface ScrapedPfmTransaction {
  transactionNumber: number;
}

type FetchedAccountData = {
  bankNumber: string;
  accountNumber: string;
  branchNumber: string;
  accountClosingReasonCode: number;
}[];

type FetchedAccountTransactionsData = {
  transactions: ScrapedTransaction[];
};

type BalanceAndCreditLimit = {
  creditLimitAmount: number;
  creditLimitDescription: string;
  creditLimitUtilizationAmount: number;
  creditLimitUtilizationExistanceCode: number;
  creditLimitUtilizationPercent: number;
  currentAccountLimitsAmount: number;
  currentBalance: number;
  withdrawalBalance: number;
};

function convertTransactions(txns: ScrapedTransaction[], options?: ScraperOptions): Transaction[] {
  return txns.map(txn => {
    const isOutbound = txn.eventActivityTypeCode === 2;

    let memo = '';
    if (txn.beneficiaryDetailsData) {
      const { partyHeadline, partyName, messageHeadline, messageDetail } = txn.beneficiaryDetailsData;
      const memoLines: string[] = [];
      if (partyHeadline) {
        memoLines.push(partyHeadline);
      }

      if (partyName) {
        memoLines.push(`${partyName}.`);
      }

      if (messageHeadline) {
        memoLines.push(messageHeadline);
      }

      if (messageDetail) {
        memoLines.push(`${messageDetail}.`);
      }

      if (memoLines.length) {
        memo = memoLines.join(' ');
      }
    }

    const result: Transaction = {
      type: TransactionTypes.Normal,
      identifier: txn.referenceNumber,
      date: moment(txn.eventDate, DATE_FORMAT).toISOString(),
      processedDate: moment(txn.valueDate, DATE_FORMAT).toISOString(),
      originalAmount: isOutbound ? -txn.eventAmount : txn.eventAmount,
      originalCurrency: 'ILS',
      chargedAmount: isOutbound ? -txn.eventAmount : txn.eventAmount,
      description: txn.activityDescription || '',
      status: txn.serialNumber === 0 ? TransactionStatuses.Pending : TransactionStatuses.Completed,
      memo,
    };

    if (options?.includeRawTransaction) {
      result.rawTransaction = getRawTransaction(txn);
    }

    return result;
  });
}

async function getRestContext(page: Page) {
  await waitUntil(() => {
    return page.evaluate(() => !!window.bnhpApp);
  }, 'waiting for app data load');

  const result = await page.evaluate(() => {
    return window.bnhpApp.restContext;
  });

  return result.slice(1);
}

async function fetchPoalimXSRFWithinPage(
  page: Page,
  url: string,
  pageUuid: string,
): Promise<FetchedAccountTransactionsData | null> {
  const cookies = await page.cookies();
  const XSRFCookie = cookies.find(cookie => cookie.name === 'XSRF-TOKEN');
  const headers: Record<string, any> = {};
  if (XSRFCookie != null) {
    headers['X-XSRF-TOKEN'] = XSRFCookie.value;
  }
  headers.pageUuid = pageUuid;
  headers.uuid = randomUUID();
  headers['Content-Type'] = 'application/json;charset=UTF-8';
  return fetchPostWithinPage<FetchedAccountTransactionsData>(page, url, [], headers);
}

async function getExtraScrap(
  txnsResult: FetchedAccountTransactionsData,
  baseUrl: string,
  page: Page,
  accountNumber: string,
): Promise<FetchedAccountTransactionsData> {
  const promises = txnsResult.transactions.map(async (transaction: ScrapedTransaction): Promise<ScrapedTransaction> => {
    const { pfmDetails, serialNumber } = transaction;
    if (serialNumber !== 0) {
      const url = `${baseUrl}${pfmDetails}&accountId=${accountNumber}&lang=he`;
      const extraTransactionDetails = (await fetchGetWithinPage<ScrapedPfmTransaction[]>(page, url)) || [];
      if (extraTransactionDetails && extraTransactionDetails.length) {
        const { transactionNumber } = extraTransactionDetails[0];
        if (transactionNumber) {
          return {
            ...transaction,
            referenceNumber: transactionNumber,
            additionalInformation: extraTransactionDetails,
          };
        }
      }
    }
    return transaction;
  });
  const res = await Promise.all(promises);
  return { transactions: res };
}

async function getAccountTransactions(
  baseUrl: string,
  apiSiteUrl: string,
  page: Page,
  accountNumber: string,
  startDate: string,
  endDate: string,
  additionalTransactionInformation = false,
  options?: ScraperOptions,
) {
  const txnsUrl = `${apiSiteUrl}/current-account/transactions?accountId=${accountNumber}&numItemsPerPage=1000&retrievalEndDate=${endDate}&retrievalStartDate=${startDate}&sortCode=1`;
  const txnsResult = await fetchPoalimXSRFWithinPage(page, txnsUrl, '/current-account/transactions');

  const finalResult =
    additionalTransactionInformation && txnsResult?.transactions.length
      ? await getExtraScrap(txnsResult, baseUrl, page, accountNumber)
      : txnsResult;

  return convertTransactions(finalResult?.transactions ?? [], options);
}

async function getAccountBalance(apiSiteUrl: string, page: Page, accountNumber: string) {
  const balanceAndCreditLimitUrl = `${apiSiteUrl}/current-account/composite/balanceAndCreditLimit?accountId=${accountNumber}&view=details&lang=he`;
  const balanceAndCreditLimit = await fetchGetWithinPage<BalanceAndCreditLimit>(page, balanceAndCreditLimitUrl);

  return balanceAndCreditLimit?.currentBalance;
}

async function fetchAccountData(page: Page, baseUrl: string, options: ScraperOptions) {
  const restContext = await getRestContext(page);
  const apiSiteUrl = `${baseUrl}/${restContext}`;
  const accountDataUrl = `${baseUrl}/ServerServices/general/accounts`;

  debug('fetching accounts data');
  const accountsInfo = (await fetchGetWithinPage<FetchedAccountData>(page, accountDataUrl)) || [];
  const openAccountsInfo = accountsInfo.filter(account => account.accountClosingReasonCode === 0);
  debug(
    'got %d open accounts from %d total accounts, fetching txns and balance',
    openAccountsInfo.length,
    accountsInfo.length,
  );

  const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
  const startDate = options.startDate || defaultStartMoment.toDate();
  const startMoment = moment.max(defaultStartMoment, moment(startDate));
  const { additionalTransactionInformation } = options;

  const startDateStr = startMoment.format(DATE_FORMAT);
  const endDateStr = moment().format(DATE_FORMAT);

  const accounts: TransactionsAccount[] = [];

  for (const account of openAccountsInfo) {
    debug('getting information for account %s', account.accountNumber);
    const accountNumber = `${account.bankNumber}-${account.branchNumber}-${account.accountNumber}`;

    const balance = await getAccountBalance(apiSiteUrl, page, accountNumber);
    const txns = await getAccountTransactions(
      baseUrl,
      apiSiteUrl,
      page,
      accountNumber,
      startDateStr,
      endDateStr,
      additionalTransactionInformation,
      options,
    );

    accounts.push({
      accountNumber,
      balance,
      txns,
    });
  }

  const accountData = {
    success: true,
    accounts,
  };
  debug('fetching ended');
  return accountData;
}

const OTP_FORM_SELECTOR = 'form.auth-otp-login';
const OTP_SUBMIT_SELECTOR = '.btn-red_1';
const OTP_ERROR_SELECTOR = '.errors-rb .error-message, .auth-otp-login .error';

// The send-again control has no stable class of its own, so the label match below is the
// real mechanism and these are only a fast path. Add one here if a stable hook shows up.
const OTP_RESEND_SELECTORS = [
  `${OTP_FORM_SELECTOR} .resend-code`,
  `${OTP_FORM_SELECTOR} a.resend`,
  `${OTP_FORM_SELECTOR} button.resend`,
];
const OTP_RESEND_PHRASES = ['שלח שוב', 'שליחה חוזרת', 'שלח קוד חדש', 'קוד חדש', 'send again', 'resend'];

function getPossibleLoginResults(baseUrl: string) {
  const urls: PossibleLoginResults = {};
  urls[LoginResults.Success] = [
    `${baseUrl}/portalserver/HomePage`,
    `${baseUrl}/ng-portals-bt/rb/he/homepage`,
    `${baseUrl}/ng-portals/rb/he/homepage`,
  ];
  urls[LoginResults.InvalidPassword] = [
    `${baseUrl}/AUTHENTICATE/LOGON?flow=AUTHENTICATE&state=LOGON&errorcode=1.6&callme=false`,
  ];
  urls[LoginResults.ChangePassword] = [
    `${baseUrl}/MCP/START?flow=MCP&state=START&expiredDate=null`,
    /\/ABOUTTOEXPIRE\/START/i,
  ];
  urls[LoginResults.TwoFactorRetrieverMissing] = [
    async (options?: { page?: Page }) => {
      if (!options?.page) return false;
      return !!(await options.page.$(OTP_FORM_SELECTOR));
    },
  ];
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: '#userCode', value: credentials.userCode },
    { selector: '#password', value: credentials.password },
  ];
}

type ScraperSpecificCredentials = {
  userCode: string;
  password: string;
  otpCodeRetriever?: OtpCodeRetriever;
};

class HapoalimScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  get baseUrl() {
    return 'https://login.bankhapoalim.co.il';
  }

  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: `${this.baseUrl}/cgi-bin/poalwwwc?reqName=getLogonPage`,
      fields: createLoginFields(credentials),
      submitButtonSelector: '.login-btn',
      postAction: async () => {
        const initialUrl = await getCurrentUrl(this.page, true);
        await waitUntil(
          async () => {
            try {
              const currentUrl = await getCurrentUrl(this.page, true);
              if (currentUrl !== initialUrl) return true;
              return !!(await this.page.$(OTP_FORM_SELECTOR));
            } catch {
              // Navigation destroyed the execution context — page is redirecting, which is progress
              return true;
            }
          },
          'waiting for redirect or OTP form',
          20000,
          1000,
        );
      },
      possibleResults: getPossibleLoginResults(this.baseUrl),
    };
  }

  async login(credentials: ScraperSpecificCredentials): Promise<ScraperLoginResult> {
    const result = await super.login(credentials);

    if (result.success || result.errorType !== ScraperErrorTypes.TwoFactorRetrieverMissing) {
      return result;
    }

    // 2FA page detected — need OTP
    if (!credentials.otpCodeRetriever) {
      debug('2FA required but no otpCodeRetriever provided');
      return {
        success: false,
        errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
        errorMessage: 'OTP code retriever is required for Hapoalim 2FA',
      };
    }

    const MAX_OTP_ATTEMPTS = 3;
    const MAX_OTP_RESENDS = 3;
    let attempt = 1;
    let resends = 0;
    let resent = false;
    let resendFailed = false;

    while (attempt <= MAX_OTP_ATTEMPTS) {
      debug(`2FA page detected, requesting OTP from caller (attempt ${attempt}/${MAX_OTP_ATTEMPTS})`);
      const otpCode = await credentials.otpCodeRetriever({ attempt, resent, resendFailed });
      resent = false;
      resendFailed = false;

      if (otpCode === OTP_RESEND) {
        if (resends >= MAX_OTP_RESENDS) {
          debug('resend requested more than %d times, giving up', MAX_OTP_RESENDS);
          return {
            success: false,
            errorType: ScraperErrorTypes.General,
            errorMessage: `OTP resend requested more than ${MAX_OTP_RESENDS} times`,
          };
        }
        resends += 1;
        resent = await this.requestNewOtpCode();
        resendFailed = !resent;
        // Deliberately does not advance `attempt`: the bank counts wrong codes, not resends.
        continue;
      }

      debug('entering OTP code');
      const otpInputs = await this.page.$$(`${OTP_FORM_SELECTOR} input[type="text"]`);
      debug('found %d OTP digit inputs', otpInputs.length);

      for (let i = 0; i < otpInputs.length; i++) {
        await otpInputs[i].click();
        await otpInputs[i].evaluate(el => {
          el.value = '';
        });
        if (i < otpCode.length) {
          await otpInputs[i].type(otpCode[i], { delay: 50 });
        }
        await sleep(100);
      }

      debug('submitting OTP');
      // Use page.click() for proper mouse events — clickButton uses synthetic el.click()
      // which Angular ignores.
      await this.page.click(OTP_SUBMIT_SELECTOR);

      try {
        await waitUntil(
          async () => {
            const otpForm = await this.page.$(OTP_FORM_SELECTOR);
            const errorEl = await this.page.$(OTP_ERROR_SELECTOR);
            const url = await getCurrentUrl(this.page, true);
            debug('OTP poll: form=%s, error=%s, url=%s', !!otpForm, !!errorEl, url);
            if (!otpForm) return 'success';
            if (errorEl) return 'error';
            return false;
          },
          'waiting for OTP result',
          20000,
          1000,
        );
      } catch {
        // Timeout: error selector didn't match but form is still showing — treat as wrong OTP
        debug('OTP waitUntil timed out — treating as wrong OTP');
      }

      if (!(await this.page.$(OTP_FORM_SELECTOR))) {
        // OTP form closed — wait for the bank to navigate to homepage
        const successPatterns = [
          '/portalserver/HomePage',
          '/ng-portals-bt/rb/he/homepage',
          '/ng-portals/rb/he/homepage',
        ];
        try {
          await waitUntil(
            async () => {
              const url = await getCurrentUrl(this.page, true);
              debug('post-OTP navigation poll: url=%s', url);
              return successPatterns.some(p => url.includes(p));
            },
            'waiting for post-OTP navigation',
            10000,
            1000,
          );
          debug('OTP verification succeeded');
          return { success: true };
        } catch {
          const current = await getCurrentUrl(this.page, true);
          debug('OTP verification failed, current url: %s', current);
          return {
            success: false,
            errorType: ScraperErrorTypes.General,
            errorMessage: 'OTP verification failed',
          };
        }
      }

      debug(`OTP attempt ${attempt} failed — inline error detected`);
      attempt += 1;
      if (attempt > MAX_OTP_ATTEMPTS) {
        return {
          success: false,
          errorType: ScraperErrorTypes.General,
          errorMessage: `OTP verification failed after ${MAX_OTP_ATTEMPTS} attempts`,
        };
      }
    }

    return {
      success: false,
      errorType: ScraperErrorTypes.General,
      errorMessage: 'OTP verification failed',
    };
  }

  /**
   * Ask the bank for a fresh OTP. Returns false when no send-again control is on the form,
   * so the caller can tell the user to use whatever code they already have.
   */
  private async requestNewOtpCode(): Promise<boolean> {
    debug('requesting a new OTP code');

    for (const selector of OTP_RESEND_SELECTORS) {
      const handle = await this.page.$(selector);
      if (handle) {
        await handle.click();
        debug('clicked resend control %s', selector);
        await sleep(2000);
        return true;
      }
    }

    // ElementHandle.click dispatches real mouse events; a synthetic el.click() from inside
    // evaluate() is ignored by this Angular app, same as the submit button.
    const candidates = await this.page.$$(`${OTP_FORM_SELECTOR} a, ${OTP_FORM_SELECTOR} button`);
    for (const handle of candidates) {
      const text = (await handle.evaluate(el => el.textContent ?? '')).trim();
      if (OTP_RESEND_PHRASES.some(phrase => text.includes(phrase))) {
        await handle.click();
        debug('clicked resend control labelled "%s"', text);
        await sleep(2000);
        return true;
      }
    }

    debug('no resend control found in the OTP form');
    return false;
  }

  async fetchData() {
    return fetchAccountData(this.page, this.baseUrl, this.options);
  }
}

export default HapoalimScraper;
