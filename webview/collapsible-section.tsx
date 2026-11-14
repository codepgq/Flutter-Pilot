import React, { useId, useState } from 'react';

export function CollapsibleSection({
  title,
  label,
  className = '',
  headingLevel = 3,
  actions,
  summary,
  children,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  title: React.ReactNode;
  label: string;
  className?: string;
  headingLevel?: 2 | 3;
  actions?: React.ReactNode;
  summary?: React.ReactNode;
  children: React.ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(true);
  const expanded = controlledExpanded ?? localExpanded;
  const contentId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={`collapsible-section ${className}`} aria-label={label}>
      <div className="collapsible-heading">
        <Heading>
          <button
            type="button"
            className="collapsible-toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => {
              setLocalExpanded(!expanded);
              onExpandedChange?.(!expanded);
            }}
          >
            <span className="collapsible-arrow" aria-hidden="true">
              ▸
            </span>
            <span className="collapsible-title">{title}</span>
            <span className="muted collapsible-hint">{expanded ? '收起' : '展开'}</span>
          </button>
        </Heading>
        {actions && <div className="collapsible-actions">{actions}</div>}
      </div>
      {summary && <div className="collapsible-summary">{summary}</div>}
      <div id={contentId} className="collapsible-content" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
