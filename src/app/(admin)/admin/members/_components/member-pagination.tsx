"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface MemberPaginationProps {
  page: number
  totalPages: number
  onPageChange: (page: number | ((current: number) => number)) => void
}

export function MemberPagination({
  page,
  totalPages,
  onPageChange,
}: MemberPaginationProps) {
  if (totalPages <= 1) return null

  return (
    <div className="flex items-center justify-between mt-4 pt-4 border-t">
      <p className="text-sm text-slate-500">
        Page {page} of {totalPages}
      </p>
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange((current) => current - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
          let pageNumber: number
          if (totalPages <= 5) pageNumber = index + 1
          else if (page <= 3) pageNumber = index + 1
          else if (page >= totalPages - 2) pageNumber = totalPages - 4 + index
          else pageNumber = page - 2 + index

          return (
            <Button
              key={pageNumber}
              variant={pageNumber === page ? "default" : "outline"}
              size="sm"
              onClick={() => onPageChange(pageNumber)}
            >
              {pageNumber}
            </Button>
          )
        })}
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange((current) => current + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
