import type { JSX } from 'preact';

export function NotFoundView({ path }: { readonly path: string }): JSX.Element {
  return (
    <section>
      <h2>Page not found</h2>
      <p>
        Nothing is routed at <code>{path}</code>.
      </p>
      <p>
        <a href="#/today">Go to Today</a>
      </p>
    </section>
  );
}
