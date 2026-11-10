import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../api/client';
import type { CostBreakdown } from '../api/types';
import { Card, ErrorNote, Label, Muted, Select, Table, Td } from '../components/ui';

const GROUPS = ['agent', 'model', 'provider', 'project', 'day'] as const;

export function CostsPage() {
  const [groupBy, setGroupBy] = useState<(typeof GROUPS)[number]>('agent');
  const data = useQuery({ queryKey: ['costs', groupBy], queryFn: () => get<CostBreakdown>(`/ai/costs/breakdown?groupBy=${groupBy}`) });
  const t = data.data?.totals;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Costs</h1>
        <div className="ml-auto w-48">
          <Label text="Group by">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as (typeof GROUPS)[number])}>
              {GROUPS.map((g) => <option key={g} value={g}>by {g}</option>)}
            </Select>
          </Label>
        </div>
      </div>
      <ErrorNote error={data.error} />
      {t && (
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            ['Model calls', t.invocations],
            ['Input tokens', t.inputTokens],
            ['Output tokens', t.outputTokens],
            ['Estimated cost', `$${t.estimatedCostUsd}`],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
              <div className="text-2xl font-semibold">{value}</div>
            </Card>
          ))}
        </div>
      )}
      {t && t.unpricedInvocations > 0 && <Muted>{t.unpricedInvocations} call(s) have no price because their model has no pricing — costs are never guessed.</Muted>}
      <Card title={`By ${groupBy}`}>
        <Table head={[groupBy, 'Calls', 'Input tokens', 'Output tokens', 'Estimated cost']} empty="No model calls yet.">
          {data.data?.groups.map((g) => (
            <tr key={g.key}>
              <Td>{g.label}</Td>
              <Td>{g.invocations}</Td>
              <Td>{g.inputTokens}</Td>
              <Td>{g.outputTokens}</Td>
              <Td>${g.estimatedCostUsd}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
