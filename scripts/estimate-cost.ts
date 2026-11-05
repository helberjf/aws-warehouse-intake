import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const snapshot = JSON.parse(await readFile(new URL('../docs/cost-rates.json', import.meta.url), 'utf8')) as {
  checkedOn: string;
  region: string;
  currency: string;
  rates: Record<string, { usd: number }>;
};
const rate = (name: string) => snapshot.rates[name].usd;
const profiles = {
  lab: {
    packagesPerDay: 100000,
    apiTasks: 1,
    workerTasks: 1,
    publisherTasks: 1,
    natGateways: 1,
    averageLcus: 1,
    logsGb: 20,
    natGb: 100,
    internetGb: 150,
    imageGb: 5,
  },
  ha: {
    packagesPerDay: 100000,
    apiTasks: 2,
    workerTasks: 2,
    publisherTasks: 1,
    natGateways: 2,
    averageLcus: 1,
    logsGb: 20,
    natGb: 100,
    internetGb: 150,
    imageGb: 5,
  },
  growth: {
    packagesPerDay: 200000,
    apiTasks: 4,
    workerTasks: 4,
    publisherTasks: 2,
    natGateways: 2,
    averageLcus: 2,
    logsGb: 40,
    natGb: 200,
    internetGb: 300,
    imageGb: 10,
  },
};
type Scenario = keyof typeof profiles;
const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    month: { type: 'string', default: '1' },
    'packages-per-day': { type: 'string' },
  },
});
const month = Number(values.month);
if (!Number.isInteger(month) || month < 1 || month > 120)
  throw new Error('Month must be an integer from 1 through 120');
if (values.scenario && !Object.hasOwn(profiles, values.scenario))
  throw new Error('Scenario must be lab, ha or growth');
const scenarios: Scenario[] = values.scenario ? [values.scenario as Scenario] : ['lab', 'ha', 'growth'];
const round = (value: number) => Math.round(value * 100) / 100;
const results = scenarios.map((scenario) => {
  const profile = { ...profiles[scenario] };
  if (values['packages-per-day']) {
    const daily = Number(values['packages-per-day']);
    if (!Number.isInteger(daily) || daily < 1 || daily > 100_000_000)
      throw new Error('Invalid package count');
    const factor = daily / profile.packagesPerDay;
    profile.packagesPerDay = daily;
    profile.logsGb *= factor;
    profile.natGb *= factor;
    profile.internetGb *= factor;
  }
  const hours = 730,
    days = 30,
    movements = profile.packagesPerDay * days;
  const retryMultiplier = 1.15;
  const vcpu = (profile.apiTasks + profile.workerTasks) * 0.5 + profile.publisherTasks * 0.25;
  const memory = profile.apiTasks + profile.workerTasks + profile.publisherTasks * 0.5;
  // Includes two <=1-KiB ConditionCheck actions billed as transactional writes.
  // 31 WRUs before allowance: 22 base-table units + 9 index units per serialized movement.
  const writeUnits = movements * 31 * retryMultiplier;
  // Includes browser authentication, lookup, two status reads and two 20-row history refreshes.
  const idleOutboxRru = 16 * hours * 3600 * 0.5 * profile.publisherTasks;
  const readUnits = movements * 31 * retryMultiplier + idleOutboxRru;
  const averagePermanentMovements = movements * (month - 0.5);
  // Payload bounds: ledger 2 KiB + idempotency 1 KiB + unit 1 KiB; history index adds 2 KiB.
  // DynamoDB storage overhead: 100 bytes per item, including each index entry.
  const publishedOutboxGb = (profile.packagesPerDay * 7 * (1024 + 100)) / 1024 ** 3;
  const tableGb = (averagePermanentMovements * (4 * 1024 + 300)) / 1024 ** 3 + publishedOutboxGb + 1;
  const totalDynamoGb = (averagePermanentMovements * (6 * 1024 + 400)) / 1024 ** 3 + publishedOutboxGb + 2;
  const eligibleSqsRequests = movements * (1 + 1 / 5 + 1) * retryMultiplier;
  const emptySqsRequests = (profile.workerTasks * hours * 3600) / 20;
  const lines = {
    fargate: hours * (vcpu * rate('fargateVcpuHour') + memory * rate('fargateMemoryGbHour')),
    alb: hours * (rate('albHour') + profile.averageLcus * rate('albLcuHour')),
    natGateways: profile.natGateways * hours * rate('natHour'),
    natProcessing: profile.natGb * rate('natGb'),
    publicIpv4: (2 + profile.natGateways) * hours * rate('publicIpv4Hour'),
    dynamoWrites: writeUnits * rate('dynamoWrite'),
    dynamoReads: readUnits * rate('dynamoRead'),
    dynamoStorage: totalDynamoGb * rate('dynamoStorageGbMonth'),
    dynamoPitr: tableGb * rate('dynamoPitrGbMonth'),
    sqs:
      eligibleSqsRequests * (rate('sqsStandardRequest') + rate('sqsFairRequest')) +
      emptySqsRequests * rate('sqsStandardRequest'),
    cloudWatch:
      profile.logsGb * (rate('logIngestGb') + rate('logStorageGbMonth') + rate('logsQueryGb')) +
      90 * rate('customMetricMonth') +
      20 * rate('alarmMetricMonth'),
    ecr: profile.imageGb * rate('ecrStorageGbMonth'),
    internetEgress: profile.internetGb * rate('internetEgressGb'),
  };
  const total = Object.values(lines).reduce((a, b) => a + b, 0);
  return {
    scenario,
    month,
    ...profile,
    monthlyMovements: movements,
    allocatedVcpu: vcpu,
    allocatedMemoryGb: memory,
    estimatedWriteUnits: round(writeUnits),
    estimatedReadUnits: round(readUnits),
    averageDynamoStorageGb: round(totalDynamoGb),
    averagePitrTableGb: round(tableGb),
    lineItemsUsd: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, round(v)])),
    totalUsd: round(total),
    budgetWith25PercentMarginUsd: round(total * 1.25),
    costPerThousandPackagesUsd: round((total / movements) * 1000),
  };
});
console.log(
  JSON.stringify(
    {
      priceSnapshot: snapshot.checkedOn,
      region: snapshot.region,
      currency: snapshot.currency,
      results,
      note: 'Planning model, not an AWS quote or throughput benchmark. Changing daily volume scales traffic assumptions, not task counts or measured capacity. No credits, tax, FX, paid support, scanners or warehouse internet included.',
    },
    null,
    2,
  ),
);
