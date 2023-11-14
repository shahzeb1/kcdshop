import { Outlet } from '@remix-run/react'

export default function ExercisesLayout() {
	return (
		<div className="h-full">
			<Outlet />
		</div>
	)
}
