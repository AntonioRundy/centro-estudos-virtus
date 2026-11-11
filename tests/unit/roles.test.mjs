import test from 'node:test';
import assert from 'node:assert/strict';
import roles from '../../lib/roles.js';

const { PROVISIONING_ROLES, canonicalRole, isProvisioningRole, isTeachingRole } = roles;

test('aceita apenas os quatro perfis canónicos no provisionamento', () => {
  for (const role of PROVISIONING_ROLES) assert.equal(isProvisioningRole(role), true);
  assert.equal(isProvisioningRole('teacher_admin'), false);
  assert.equal(isProvisioningRole('superadmin'), false);
});

test('a conversão de papel legado preserva professor administrador', () => {
  assert.equal(canonicalRole('teacher_admin'), 'admin_teacher');
  assert.equal(canonicalRole('teacher'), 'teacher');
  assert.equal(isTeachingRole('teacher_admin'), true);
  assert.equal(isTeachingRole('admin_teacher'), true);
  assert.equal(isTeachingRole('secretary'), false);
});
