import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { LandscapeSurface, Project } from '$lib/models/types';
import { createDefaultProject, currentProject, loadProject, redo, undo, updateProjectDefaultGround } from '$lib/stores/project';
import { readOnly } from '$lib/stores/readOnly';
import { readProject } from '$lib/utils/projectValidation';
import { sceneSignature } from '$lib/utils/sceneSignature';
import { roomProject } from './fixtures/project';

const project = () => get(currentProject)!;

beforeEach(() => {
  readOnly.set(false);
  loadProject(createDefaultProject('Default ground'));
});

describe('Project default ground', () => {
  it('starts plain, sets a surface and clears it, each as one undo step', () => {
    expect(project().defaultGround).toBeUndefined();
    updateProjectDefaultGround('grass');
    expect(project().defaultGround).toBe('grass');
    updateProjectDefaultGround('gravel');
    updateProjectDefaultGround();
    expect(project().defaultGround).toBeUndefined();
    undo();
    expect(project().defaultGround).toBe('gravel');
    undo();
    expect(project().defaultGround).toBe('grass');
    undo();
    expect(project().defaultGround).toBeUndefined();
    redo();
    expect(project().defaultGround).toBe('grass');
  });

  it('ignores unknown surfaces, repeats and read-only projects', () => {
    updateProjectDefaultGround('lava' as LandscapeSurface);
    expect(project().defaultGround).toBeUndefined();
    updateProjectDefaultGround('soil');
    const before = project();
    updateProjectDefaultGround('soil');
    expect(project()).toBe(before);
    readOnly.set(true);
    updateProjectDefaultGround('tarmac');
    expect(project().defaultGround).toBe('soil');
  });

  it('rebuilds the 3D scene when it changes', () => {
    const floor = project().floors[0];
    const plain = sceneSignature(project(), floor, false, 'metric');
    updateProjectDefaultGround('grass');
    expect(sceneSignature(project(), project().floors[0], false, 'metric')).not.toBe(plain);
  });

  it('loads a saved surface and drops an unknown one', () => {
    const withGround = (defaultGround?: unknown): Project => ({ ...roomProject(), defaultGround } as Project);
    expect(readProject(withGround('concrete')).defaultGround).toBe('concrete');
    expect(readProject(withGround()).defaultGround).toBeUndefined();
    expect('defaultGround' in readProject(withGround('lava'))).toBe(false);
  });
});
