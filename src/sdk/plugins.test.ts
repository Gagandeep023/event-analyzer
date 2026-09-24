// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { clicksPlugin, optOutPlugin } from './plugins';
import type { ResolvedSdkConfig } from '../types';

const config = {} as ResolvedSdkConfig;

function setup(html: string, options = {}) {
  document.body.innerHTML = html;
  const track = vi.fn();
  const plugin = clicksPlugin({ track }, options);
  void plugin.setup?.(config, null);
  return { track, plugin };
}

function click(selector: string) {
  document.querySelector(selector)!.dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
}

describe('clicks autocapture', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('records tag, selector and text', () => {
    const { track } = setup('<button id="cta">Install now</button>');
    click('#cta');
    expect(track).toHaveBeenCalledWith('Element Clicked', expect.objectContaining({
      tag: 'button', selector: 'button', text: 'Install now', element_id: 'cta',
    }));
  });

  it('records the destination of a link', () => {
    // Without href a report says "Read more" was clicked 400 times but not
    // where any of them went.
    const { track } = setup('<a id="x" href="/blog/post-one">Read more</a>');
    click('#x');
    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.href).toBe('/blog/post-one');
    expect(props.external).toBe(false);
  });

  it('flags an external link and its host', () => {
    const { track } = setup('<a id="x" href="https://www.github.com/a">GitHub</a>');
    click('#x');
    const props = track.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.external).toBe(true);
    expect(props.href_host).toBe('github.com');
  });

  it('classifies downloads and mailto links', () => {
    const { track } = setup('<a id="d" href="/files/guide.pdf">Guide</a><a id="m" href="mailto:a@b.c">Mail</a>');
    click('#d');
    click('#m');
    expect((track.mock.calls[0]![1] as Record<string, unknown>).href_kind).toBe('download');
    expect((track.mock.calls[1]![1] as Record<string, unknown>).href_kind).toBe('mailto');
  });

  it('captures a click on a child of an allowlisted element', () => {
    const { track } = setup('<button id="b"><span id="inner">Go</span></button>');
    click('#inner');
    expect(track).toHaveBeenCalledOnce();
  });

  it('ignores elements outside the allowlist', () => {
    const { track } = setup('<div id="plain">Not tracked</div>');
    click('#plain');
    expect(track).not.toHaveBeenCalled();
  });

  it('never captures anything from a password field', () => {
    const { track } = setup('<button id="f"><input type="password" value="hunter2" /></button>');
    click('#f');
    expect(track).not.toHaveBeenCalled();
  });

  it('truncates long text', () => {
    const { track } = setup(`<button id="b">${'x'.repeat(400)}</button>`, { maxTextLength: 20 });
    click('#b');
    expect(((track.mock.calls[0]![1] as Record<string, string>).text)).toHaveLength(20);
  });

  it('picks up data-ea-* attributes', () => {
    const { track } = setup('<button id="b" data-ea-tool="merge-pdf">Merge</button>');
    click('#b');
    expect((track.mock.calls[0]![1] as Record<string, unknown>).tool).toBe('merge-pdf');
  });

  it('stops capturing after teardown', () => {
    const { track, plugin } = setup('<button id="b">Go</button>');
    void plugin.teardown?.();
    click('#b');
    expect(track).not.toHaveBeenCalled();
  });
});

describe('opt out plugin', () => {
  it('drops every event while opted out', async () => {
    const p = optOutPlugin(() => true);
    expect(await p.execute!({ event_type: 'A' })).toBeNull();
  });

  it('passes events through otherwise', async () => {
    const p = optOutPlugin(() => false);
    expect(await p.execute!({ event_type: 'A' })).toMatchObject({ event_type: 'A' });
  });
});
