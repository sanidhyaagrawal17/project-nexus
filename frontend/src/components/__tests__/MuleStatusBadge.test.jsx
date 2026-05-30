import React from 'react';
import { render, screen } from '@testing-library/react';
import MuleStatusBadge from '../MuleStatusBadge';

describe('MuleStatusBadge', () => {
  test('renders Pending by default', () => {
    render(<MuleStatusBadge />);
    expect(screen.getByTestId('mule-badge')).toHaveTextContent('Pending');
  });

  test('renders Confirmed Mule style', () => {
    render(<MuleStatusBadge status="Confirmed Mule" />);
    expect(screen.getByTestId('mule-badge')).toHaveTextContent('Confirmed Mule');
  });

  test('renders Not a Mule style', () => {
    render(<MuleStatusBadge status="Not a Mule" />);
    expect(screen.getByTestId('mule-badge')).toHaveTextContent('Not a Mule');
  });
});
