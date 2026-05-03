import { describe, expect, it } from 'vitest';
import { igSinglePostContentType } from '../../src/services/creative/contentTypes/igSinglePost.js';
import {
  expandInvalidatedSteps,
  getContentType,
  listContentTypes,
} from '../../src/services/creative/registry.js';
import type { StepArtifacts } from '../../src/services/creative/types.js';

describe('content-type registry', () => {
  it('exposes igSinglePost', () => {
    expect(getContentType('igSinglePost').id).toBe('igSinglePost');
    expect(listContentTypes().map((c) => c.id)).toContain('igSinglePost');
  });

  it('throws on unknown id', () => {
    expect(() => getContentType('missing')).toThrow(/Unknown contentType/);
  });
});

describe('igSinglePost pipeline DAG', () => {
  it('declares steps in execution order', () => {
    expect(igSinglePostContentType.pipeline.map((s) => s.id)).toEqual([
      'ideation',
      'copy',
      'hashtags',
      'artDirection',
      'image',
    ]);
  });

  it('hashtags depends on copy, image depends on artDirection', () => {
    const byId = Object.fromEntries(igSinglePostContentType.pipeline.map((s) => [s.id, s]));
    expect(byId.hashtags?.dependsOn).toEqual(['copy']);
    expect(byId.image?.dependsOn).toEqual(['artDirection']);
    expect(byId.ideation?.dependsOn).toEqual([]);
  });
});

describe('expandInvalidatedSteps', () => {
  it('cascades downstream invalidation (copy → hashtags)', () => {
    const out = expandInvalidatedSteps(igSinglePostContentType, ['copy']);
    expect(out).toEqual(['copy', 'hashtags']);
  });

  it('cascades from artDirection to image', () => {
    const out = expandInvalidatedSteps(igSinglePostContentType, ['artDirection']);
    expect(out).toEqual(['artDirection', 'image']);
  });

  it('rips out everything when ideation is invalidated', () => {
    const out = expandInvalidatedSteps(igSinglePostContentType, ['ideation']);
    expect(out).toEqual(['ideation', 'copy', 'hashtags', 'artDirection', 'image']);
  });

  it('merges multiple seeds without dupes, preserves pipeline order', () => {
    const out = expandInvalidatedSteps(igSinglePostContentType, ['hashtags', 'image']);
    expect(out).toEqual(['hashtags', 'image']);
  });
});

describe('igSinglePost.toPostDraft', () => {
  const fullArtifacts: StepArtifacts = {
    ideation: {
      topic: 't',
      angle: 'a sufficiently long angle',
      themes: [],
      rationale: 'r',
    },
    copy: {
      hook: 'Hook line.',
      body: 'Body paragraph.',
      cta: 'Call to action.',
      fullCaption: 'Hook line.\n\nBody paragraph.\n\nCall to action.',
    },
    hashtags: { hashtags: ['matcha', '#slowpour'] },
    artDirection: {
      subject: 's',
      composition: 'c',
      lighting: 'l',
      palette: ['#fff'],
      mood: 'm',
      imagePrompt: 'a thirty-word minimum vivid description for the image model to render it.',
      size: '1024x1536',
    },
    image: {
      url: 'https://cdn.example.com/x.png',
      key: 'images/x.png',
      prompt: 'p',
    },
  };

  it('assembles caption with hashtags appended', () => {
    const out = igSinglePostContentType.toPostDraft(fullArtifacts);
    expect(out.caption).toBe(
      'Hook line.\n\nBody paragraph.\n\nCall to action.\n\n#matcha #slowpour',
    );
    expect(out.mediaUrls).toEqual(['https://cdn.example.com/x.png']);
  });

  it('assembles caption without hashtag block when tags list is empty', () => {
    const out = igSinglePostContentType.toPostDraft({
      ...fullArtifacts,
      hashtags: { hashtags: [] },
    });
    expect(out.caption).toBe('Hook line.\n\nBody paragraph.\n\nCall to action.');
  });

  it('throws if copy or image is missing', () => {
    const withoutCopy: StepArtifacts = { ...fullArtifacts };
    delete withoutCopy.copy;
    expect(() => igSinglePostContentType.toPostDraft(withoutCopy)).toThrow(/copy/);

    const withoutImage: StepArtifacts = { ...fullArtifacts };
    delete withoutImage.image;
    expect(() => igSinglePostContentType.toPostDraft(withoutImage)).toThrow(/image/);
  });
});
